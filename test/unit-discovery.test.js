"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BEAVER_SERVICE_TYPE,
  createUnitDiscoverer,
  discoverBeaverUnits,
  interfaceAddresses,
  normalizeServices,
} = require("../src/unit-discovery");

const NETWORK_INTERFACES = {
  lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  eth0: [{ address: "192.168.1.10", family: "IPv4", internal: false }],
  vpn0: [
    { address: "100.64.0.10", family: 4, internal: false },
    { address: "fd00::10", family: "IPv6", internal: false },
  ],
};

test("unit discovery resolves configured interface names and non-loopback IPv4 addresses", () => {
  assert.deepEqual(interfaceAddresses([], NETWORK_INTERFACES), ["192.168.1.10", "100.64.0.10"]);
  assert.deepEqual(interfaceAddresses(["vpn0"], NETWORK_INTERFACES), ["100.64.0.10"]);
  assert.deepEqual(interfaceAddresses(["192.168.1.10"], NETWORK_INTERFACES), ["192.168.1.10"]);
  assert.throws(() => interfaceAddresses(["missing0"], NETWORK_INTERFACES), /not available: missing0/);
  assert.throws(() => interfaceAddresses([], { lo: NETWORK_INTERFACES.lo }), /No non-loopback IPv4/);
});

test("unit discovery normalizes, filters and deduplicates mDNS services", () => {
  const units = normalizeServices([
    {
      name: "Mitsubishi WF-RAC 000000000000",
      fqdn: "000000000000._beaver._tcp.local",
      host: "wfrac-2630.local.",
      port: 51443,
      addresses: ["fe80::1234", "192.168.1.50"],
      referer: { address: "192.168.1.50" },
    },
    {
      name: "Mitsubishi WF-RAC 000000000000",
      fqdn: "000000000000._beaver._tcp.local",
      host: "wfrac-2630.local.",
      port: 51443,
      addresses: ["192.168.1.50"],
    },
    { name: "Invalid", port: 0, addresses: ["192.168.1.2"] },
    { name: "Second", host: "192.168.1.25", port: 51443 },
  ]);

  assert.equal(units.length, 2);
  units.forEach((unit) => assert.match(unit.discoveryId, /^[0-9a-f]{64}$/));
  assert.notEqual(units[0].discoveryId, units[1].discoveryId);
  assert.deepEqual(units.map(({ discoveryId, ...unit }) => unit), [
    { name: "Mitsubishi WF-RAC", ip: "192.168.1.25", port: 51443 },
    {
      name: "Mitsubishi WF-RAC",
      ip: "192.168.1.50",
      port: 51443,
    },
  ]);
});

test("unit discovery browses _beaver._tcp on each selected interface and cleans up", async () => {
  const calls = [];
  const servicesByInterface = {
    "192.168.1.10": [{
      name: "Mitsubishi WF-RAC 000000000000",
      fqdn: "000000000000._beaver._tcp.local",
      host: "wfrac.local",
      port: 51443,
      addresses: ["192.168.1.50"],
    }],
    "100.64.0.10": [],
  };

  const units = await discoverBeaverUnits({ timeoutMs: 25 }, {
    getNetworkInterfaces: () => NETWORK_INTERFACES,
    wait: async (milliseconds) => calls.push({ method: "wait", milliseconds }),
    createBonjour(options) {
      calls.push({ method: "create", options });
      const services = servicesByInterface[options.interface];
      return {
        find(query, onup) {
          calls.push({ method: "find", query, interface: options.interface });
          services.forEach(onup);
          return {
            services,
            stop: () => calls.push({ method: "stop", interface: options.interface }),
          };
        },
        destroy: () => calls.push({ method: "destroy", interface: options.interface }),
      };
    },
  });

  assert.equal(units.length, 1);
  assert.match(units[0].discoveryId, /^[0-9a-f]{64}$/);
  const { discoveryId, ...unit } = units[0];
  assert.ok(discoveryId);
  assert.deepEqual(unit, {
    name: "Mitsubishi WF-RAC",
    ip: "192.168.1.50",
    port: 51443,
  });
  assert.deepEqual(calls.filter((call) => call.method === "create").map((call) => call.options), [
    { bind: "0.0.0.0", interface: "192.168.1.10" },
    { bind: "0.0.0.0", interface: "100.64.0.10" },
  ]);
  assert.ok(calls.filter((call) => call.method === "find").every((call) => (
    call.query.type === BEAVER_SERVICE_TYPE && call.query.protocol === "tcp"
  )));
  assert.equal(calls.filter((call) => call.method === "stop").length, 2);
  assert.equal(calls.filter((call) => call.method === "destroy").length, 2);
});

test("concurrent discovery requests share one active mDNS scan", async () => {
  let releaseScan;
  let waits = 0;
  const discover = createUnitDiscoverer({ timeoutMs: 10 }, {
    getNetworkInterfaces: () => NETWORK_INTERFACES,
    wait: () => {
      waits += 1;
      return new Promise((resolve) => { releaseScan = resolve; });
    },
    createBonjour: () => ({
      find: () => ({ services: [], stop() {} }),
      destroy() {},
    }),
  });

  const first = discover();
  const second = discover();
  assert.equal(first, second);
  assert.equal(waits, 1);
  releaseScan();
  assert.deepEqual(await first, []);
});
