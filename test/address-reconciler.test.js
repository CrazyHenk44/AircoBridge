"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createAddressReconciler } = require("../src/address-reconciler");
const { AircoManager } = require("../src/airco-manager");
const { WfracStatus } = require("../src/wfrac");

const DISCOVERY_ID = "a".repeat(64);

function writeConfig(directory, airco) {
  const file = path.join(directory, "aircos.json");
  fs.writeFileSync(file, `${JSON.stringify({ server: {}, aircos: [airco] }, null, 2)}\n`);
  return file;
}

test("mDNS reconciliation learns a stable identity and persists a changed endpoint", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airco-address-reconciler-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = {
    id: "living-room",
    name: "Living room",
    ip: "192.168.1.40",
    port: 51443,
    discoveryId: null,
    deviceId: "test-device",
    operatorId: "test-operator",
  };
  const configFile = writeConfig(directory, config);
  const endpointUpdates = [];
  const logs = [];
  const manager = {
    configs: () => [config],
    updateEndpoint(id, unit) {
      endpointUpdates.push({ id, ip: unit.ip, port: unit.port });
      config.ip = unit.ip;
      config.port = unit.port;
    },
  };
  const reconciler = createAddressReconciler(manager, {
    configFile,
    discoverUnits: async () => [{
      name: "Mitsubishi WF-RAC",
      discoveryId: DISCOVERY_ID,
      ip: "192.168.1.50",
      port: 51443,
    }],
  }, { log: (message) => logs.push(message) });

  const changes = await reconciler.reconcile({ force: true });

  assert.deepEqual(changes, [{
    id: "living-room",
    addressChanged: true,
    learnedIdentity: true,
    ip: "192.168.1.50",
    port: 51443,
  }]);
  assert.deepEqual(endpointUpdates, [{ id: "living-room", ip: "192.168.1.50", port: 51443 }]);
  assert.match(logs[0], /updated living-room endpoint/);
  const persisted = JSON.parse(fs.readFileSync(configFile, "utf8")).aircos[0];
  assert.equal(persisted.discoveryId, DISCOVERY_ID);
  assert.equal(persisted.ip, "192.168.1.50");
  assert.equal(persisted.deviceId, "test-device");
});

test("a failed refresh retries once after mDNS changes the runtime endpoint", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airco-address-recovery-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = {
    id: "living-room",
    name: "Living room",
    ip: "192.168.1.40",
    port: 51443,
    discoveryId: DISCOVERY_ID,
    deviceId: "test-device",
    operatorId: "test-operator",
    airconId: "1",
    httpsMode: true,
    pollIntervalMs: 30000,
    timeoutMs: 10000,
  };
  const manager = new AircoManager([config], path.join(directory, "history.json"));
  const runtime = manager.get("living-room");
  let requests = 0;
  runtime.client = {
    ip: config.ip,
    port: config.port,
    async getStatus() {
      requests += 1;
      if (this.ip === "192.168.1.40") throw new Error("host unreachable");
      return { raw: {}, status: new WfracStatus() };
    },
  };
  manager.setAddressRecovery(async () => {
    manager.updateEndpoint("living-room", { ip: "192.168.1.50", port: 51443 });
    return true;
  });

  const snapshot = await runtime.refresh();

  assert.equal(requests, 2);
  assert.equal(snapshot.online, true);
  assert.equal(snapshot.airco.ip, "192.168.1.50");
  assert.equal(snapshot.airco.addressManaged, true);
  assert.equal(runtime.lastError, null);
});

test("mDNS reconciliation does not guess when multiple unlinked configs are ambiguous", async () => {
  const configs = [
    { id: "one", ip: "192.168.1.40", port: 51443, discoveryId: null },
    { id: "two", ip: "192.168.1.41", port: 51443, discoveryId: null },
  ];
  const manager = {
    configs: () => configs,
    updateEndpoint: () => assert.fail("ambiguous endpoints must not be changed"),
  };
  const reconciler = createAddressReconciler(manager, {
    discoverUnits: async () => [{ discoveryId: DISCOVERY_ID, ip: "192.168.1.50", port: 51443 }],
  }, { log: () => {} });

  assert.deepEqual(await reconciler.reconcile({ force: true }), []);
  assert.equal(configs.every((config) => config.discoveryId === null), true);
});
