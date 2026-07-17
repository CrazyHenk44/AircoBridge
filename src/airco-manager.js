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
  }

  publicConfig() {
    return {
      id: this.config.id,
      name: this.config.name,
      ip: this.config.ip,
      port: this.config.port,
      airconId: this.config.airconId,
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
      status: this.status ? this.status.toJSON({ debug: includeDebug }) : null,
      history: this.historyStore.summarize(this.config.id, this.status),
    };

    if (includeRaw) value.raw = this.raw;
    return normalizeSnapshotForApi(value);
  }

  async refresh() {
    try {
      const { raw, status } = await this.client.getStatus();
      this.raw = raw;
      this.status = status;
      this.lastUpdate = new Date().toISOString();
      this.lastError = null;
      this.online = true;
      this.historyStore.recordPoll(this.config.id, status);
      return this.snapshot();
    } catch (err) {
      this.lastError = toError(err);
      this.online = false;
      throw err;
    }
  }

  enqueue(action) {
    const run = this.queue.then(action, action);
    this.queue = run.catch(() => {});
    return run;
  }

  async update(mutator) {
    return this.enqueue(async () => {
      const { status } = await this.client.getStatus();
      await mutator(status);
      await this.client.setStatus(status);
      return this.refresh();
    });
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

module.exports = { AircoManager };
