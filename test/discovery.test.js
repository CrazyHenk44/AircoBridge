"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { loadOrCreateBridgeId } = require("../src/bridge-identity");
const { SERVICE_TYPE, listAdvertisableInterfaces, startDiscovery } = require("../src/discovery");

test("bridge identity is generated once and remains stable", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airco-bridge-id-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "nested", "bridge-id");

  const first = loadOrCreateBridgeId(file);
  const second = loadOrCreateBridgeId(file);

  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.equal(second, first);
  assert.equal(fs.readFileSync(file, "utf8"), `${first}\n`);
});

test("invalid persisted bridge identities fail instead of silently changing identity", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airco-bridge-id-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "bridge-id");
  fs.writeFileSync(file, "not-a-uuid\n");

  assert.throws(() => loadOrCreateBridgeId(file), /Invalid bridge ID/);
});

test("mDNS advertises a stable Homey-compatible service and shuts down once", async () => {
  const calls = [];
  const service = {
    on(event) {
      calls.push({ method: "on", event });
      return this;
    },
    async advertise() {
      calls.push({ method: "advertise" });
    },
  };
  const responder = {
    createService(options) {
      calls.push({ method: "createService", options });
      return service;
    },
    async shutdown() {
      calls.push({ method: "shutdown" });
    },
  };
  const bridgeId = "71bc0a85-836d-4ed7-94bb-8ff12193f378";

  const discovery = await startDiscovery({
    bridgeId,
    port: 3000,
    version: "1.2.0",
    interfaces: ["eth0"],
  }, {
    getResponder(options) {
      calls.push({ method: "getResponder", options });
      return responder;
    },
    getNetworkInterfaces: () => ({
      eth0: [{ address: "192.168.1.111", family: "IPv4", internal: false }],
    }),
  });
  await discovery.stop();
  await discovery.stop();

  const creation = calls.find((call) => call.method === "createService");
  assert.deepEqual(creation.options, {
    name: "AircoBridge 71bc0a85",
    hostname: "aircobridge-71bc0a85",
    type: SERVICE_TYPE,
    port: 3000,
    disabledIpv6: true,
    restrictedAddresses: ["eth0"],
    txt: {
      id: bridgeId,
      product: SERVICE_TYPE,
      api: "1",
      version: "1.2.0",
      scheme: "http",
    },
  });
  assert.equal(calls.filter((call) => call.method === "advertise").length, 1);
  assert.equal(calls.filter((call) => call.method === "shutdown").length, 1);
  assert.deepEqual(calls.find((call) => call.method === "getResponder").options, {
    interface: ["eth0"],
    excludeIpv6: true,
  });
  assert.deepEqual(discovery.interfaces, ["eth0"]);
});

test("mDNS binds every non-loopback IPv4 interface when none is configured", () => {
  assert.deepEqual(listAdvertisableInterfaces({
    lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    eth0: [{ address: "192.168.1.111", family: "IPv4", internal: false }],
    wt0: [{ address: "100.127.113.32", family: 4, internal: false }],
    ipv6only: [{ address: "fe80::1", family: "IPv6", internal: false }],
  }), ["eth0", "wt0"]);
});

test("mDNS rejects a configured interface that cannot advertise IPv4", async () => {
  await assert.rejects(() => startDiscovery({
    bridgeId: "71bc0a85-836d-4ed7-94bb-8ff12193f378",
    port: 3000,
    version: "1.2.0",
    interfaces: ["missing0"],
  }, {
    getResponder: () => assert.fail("responder must not be created"),
    getNetworkInterfaces: () => ({
      eth0: [{ address: "192.168.1.111", family: "IPv4", internal: false }],
    }),
  }), /not available: missing0/);
});
