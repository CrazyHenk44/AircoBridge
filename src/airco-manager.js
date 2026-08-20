"use strict";

const { WfracClient } = require("./wfrac");
const { HistoryStore } = require("./history-store");
const { BRIDGE_DEVICE_PREFIX } = require("./registration");

function toError(err) {
  return {
    message: err?.message || String(err),
    time: new Date().toISOString(),
  };
}

function normalizeSnapshotForApi(snapshot) {
  if (!snapshot?.status || snapshot.status.power !== "off") return snapshot;

  return {
    ...snapshot,
    status: {
      ...snapshot.status,
      electric: 0,
    },
    history: snapshot.history
      ? {
          ...snapshot.history,
          currentWatts: 0,
        }
      : snapshot.history,
  };
}

function combineSelfCleanStatus(status, managedSelfClean) {
  if (!status) return status;
  const deviceActive = Boolean(status.isSelfCleanOperation);
  const managedActive = Boolean(managedSelfClean);
  const combinedActive = deviceActive || managedActive;
  return {
    ...status,
    deviceSelfCleanOperation: deviceActive,
    managedSelfCleanOperation: managedActive,
    isSelfCleanOperation: combinedActive,
    selfCleanOperationLabel: combinedActive ? "Self-clean active" : "Self-clean off",
    selfCleanSource: deviceActive && managedActive
      ? "device+automation"
      : deviceActive ? "device" : managedActive ? "automation" : null,
    selfCleanUntil: managedSelfClean?.endsAt || null,
  };
}

class AircoRuntime {
  constructor(config, historyStore) {
    this.config = config;
    this.client = new WfracClient(config);
    this.historyStore = historyStore;
    this.status = null;
    this.raw = null;
    this.lastUpdate = null;
    this.lastError = null;
    this.online = false;
    this.timer = null;
    this.queue = Promise.resolve();
    this.vacantPresetRestoreState = null;
    this.managedSelfClean = null;
    this.addressRecovery = null;
  }

  publicConfig() {
    return {
      id: this.config.id,
      name: this.config.name,
      ip: this.config.ip,
      port: this.config.port,
      airconId: this.config.airconId,
      addressManaged: Boolean(this.config.discoveryId),
      httpsMode: this.config.httpsMode,
      pollIntervalMs: this.config.pollIntervalMs,
    };
  }

  snapshot({ includeRaw = false, includeDebug = false } = {}) {
    const value = {
      airco: this.publicConfig(),
      online: this.online,
      lastUpdate: this.lastUpdate,
      lastError: this.lastError,
      status: this.status
        ? combineSelfCleanStatus(this.status.toJSON({ debug: includeDebug }), this.managedSelfClean)
        : null,
      history: this.historyStore.summarize(this.config.id, this.status),
    };

    if (includeRaw) value.raw = this.raw;
    return normalizeSnapshotForApi(value);
  }

  refresh(options = {}) {
    return this.enqueue(() => this.performRefresh(options));
  }

  async performRefresh({ recoverAddress = true } = {}) {
    const attemptedIp = this.client.ip;
    const attemptedPort = this.client.port;
    try {
      const statusReader = this.client.getStatusWithOperationData || this.client.getStatus;
      const { raw, status } = await statusReader.call(this.client);
      this.raw = raw;
      this.status = status;
      this.lastUpdate = new Date().toISOString();
      this.lastError = null;
      this.online = true;
      this.historyStore.recordPoll(this.config.id, status);
      return this.snapshot();
    } catch (err) {
      const endpointChanged = this.client.ip !== attemptedIp || this.client.port !== attemptedPort;
      if (recoverAddress && (endpointChanged || await this.tryAddressRecovery(err))) {
        return this.performRefresh({ recoverAddress: false });
      }
      this.lastError = toError(err);
      this.online = false;
      throw err;
    }
  }

  setManagedSelfClean(value) {
    this.managedSelfClean = value ? structuredClone(value) : null;
  }

  async tryAddressRecovery(originalError) {
    if (!this.addressRecovery) return false;
    try {
      return await this.addressRecovery(this.config, originalError);
    } catch (recoveryError) {
      console.warn(`mDNS address recovery failed for ${this.config.id}: ${recoveryError.message || recoveryError}`);
      return false;
    }
  }

  updateEndpoint({ ip, port }) {
    const normalizedPort = Number(port);
    if (this.config.ip === ip && Number(this.config.port) === normalizedPort) return false;
    this.config.ip = ip;
    this.config.port = normalizedPort;
    this.client.ip = ip;
    this.client.port = normalizedPort;
    return true;
  }

  enqueue(action) {
    const run = this.queue.then(action, action);
    this.queue = run.catch(() => {});
    return run;
  }

  async update(mutator) {
    return this.enqueue(() => this.performUpdate(mutator));
  }

  async performUpdate(mutator, { recoverAddress = true } = {}) {
    const attemptedIp = this.client.ip;
    const attemptedPort = this.client.port;
    try {
      const { status } = await this.client.getStatus();
      await mutator(status);
      await this.client.setStatus(status);
      return this.performRefresh();
    } catch (err) {
      const endpointChanged = this.client.ip !== attemptedIp || this.client.port !== attemptedPort;
      if (recoverAddress && (endpointChanged || await this.tryAddressRecovery(err))) {
        return this.performUpdate(mutator, { recoverAddress: false });
      }
      throw err;
    }
  }

  start() {
    const poll = () => {
      this.refresh().catch(() => {});
    };
    poll();
    this.timer = setInterval(poll, this.config.pollIntervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

class AircoManager {
  constructor(configs, historyFile = "data/airco-history.json") {
    this.historyStore = new HistoryStore(historyFile);
    this.addressRecovery = null;
    this.aircos = new Map(configs.map((config) => [config.id, new AircoRuntime(config, this.historyStore)]));
  }

  start() {
    for (const runtime of this.aircos.values()) runtime.start();
  }

  stop() {
    for (const runtime of this.aircos.values()) runtime.stop();
  }

  list() {
    return [...this.aircos.values()].map((runtime) => {
      const snapshot = runtime.snapshot();
      snapshot.airco.bridgeManagedIdentity = String(runtime.config.deviceId).startsWith(BRIDGE_DEVICE_PREFIX);
      snapshot.airco.identityShared = this.identityShared(runtime.config);
      return snapshot;
    });
  }

  identityShared(config) {
    return this.configs().some(
      (other) => other.id !== config.id && other.operatorId === config.operatorId && other.ip === config.ip
    );
  }

  has(id) {
    return this.aircos.has(id);
  }

  add(config) {
    if (this.aircos.has(config.id)) throw new Error(`Air conditioner already exists: ${config.id}`);
    const runtime = new AircoRuntime(config, this.historyStore);
    runtime.addressRecovery = this.addressRecovery;
    this.aircos.set(config.id, runtime);
    runtime.start();
    return runtime;
  }

  remove(id) {
    const runtime = this.get(id);
    runtime.stop();
    this.aircos.delete(id);
    this.historyStore.remove(id);
    return runtime;
  }

  configs() {
    return [...this.aircos.values()].map((runtime) => runtime.config);
  }

  setAddressRecovery(handler) {
    this.addressRecovery = handler;
    for (const runtime of this.aircos.values()) runtime.addressRecovery = handler;
  }

  updateEndpoint(id, endpoint) {
    return this.get(id).updateEndpoint(endpoint);
  }

  get(id) {
    const runtime = this.aircos.get(id);
    if (!runtime) {
      const err = new Error(`Unknown air conditioner: ${id}`);
      err.statusCode = 404;
      throw err;
    }
    return runtime;
  }
}

module.exports = { AircoManager, combineSelfCleanStatus };
