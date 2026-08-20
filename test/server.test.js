"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");

const { PresetStore } = require("../src/preset-store");
const { createServer } = require("../src/server");
const { WfracStatus } = require("../src/wfrac");

function dispatch(server, { method = "GET", url = "/", body = "" } = {}) {
  return new Promise((resolve) => {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    req.method = method;
    req.url = url;

    const response = { statusCode: null, headers: null, body: "" };
    const res = {
      writeHead(statusCode, headers = {}) {
        response.statusCode = statusCode;
        response.headers = headers;
      },
      end(value = "") {
        response.body = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
        resolve(response);
      },
    };

    server.emit("request", req, res);
  });
}

test("server parses boolean payloads, limits bodies, and sends security headers", async () => {
  const powerValues = [];
  const runtime = {
    async update(mutator) {
      mutator({ setPower: (value) => powerValues.push(value) });
      return { ok: true };
    },
  };
  const manager = { get: () => runtime };
  const server = createServer(manager);

  const powerResponse = await dispatch(server, {
    method: "POST",
    url: "/api/aircos/test/power",
    body: JSON.stringify({ operation: "off" }),
  });
  assert.equal(powerResponse.statusCode, 200);
  assert.deepEqual(powerValues, [false]);

  const invalidResponse = await dispatch(server, {
    method: "POST",
    url: "/api/aircos/test/power",
    body: JSON.stringify({ power: "invalid" }),
  });
  assert.equal(invalidResponse.statusCode, 400);

  const largeResponse = await dispatch(server, {
    method: "POST",
    url: "/api/aircos/test/power",
    body: JSON.stringify({ value: "x".repeat(65_536) }),
  });
  assert.equal(largeResponse.statusCode, 413);

  const pageResponse = await dispatch(server);
  assert.equal(pageResponse.statusCode, 200);
  assert.match(pageResponse.headers["Content-Security-Policy"], /default-src 'self'/);
  assert.equal(pageResponse.headers["X-Content-Type-Options"], "nosniff");
});

test("server advertises API capabilities without changing legacy routes", async () => {
  const manager = {
    list: () => [],
  };
  const bridgeId = "71bc0a85-836d-4ed7-94bb-8ff12193f378";
  const server = createServer(manager, { bridgeId });

  const infoResponse = await dispatch(server, { url: "/api/info" });
  assert.equal(infoResponse.statusCode, 200);
  const info = JSON.parse(infoResponse.body);
  assert.equal(info.name, "AircoBridge");
  assert.equal(info.apiVersion, 1);
  assert.equal(info.bridgeId, bridgeId);
  assert.equal(info.features.discovery, true);
  assert.equal(info.features.unitDiscovery, false);
  assert.equal(info.features.presets, true);
  assert.equal(info.features.globalPresets, true);
  assert.equal(info.features.automations, false);
  assert.equal(info.features.automationLog, false);
  assert.equal(info.features.manualOverride, false);

  const legacyResponse = await dispatch(server, { url: "/api/aircos" });
  assert.equal(legacyResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(legacyResponse.body), { aircos: [] });
});

test("manual API control starts and clears a per-unit automation override", async () => {
  const status = new WfracStatus();
  status.setPower(false);
  const runtime = {
    config: { id: "living-room" },
    snapshot: () => ({ airco: { id: "living-room" }, online: true, status: status.toJSON() }),
    async update(mutator) {
      mutator(status);
      return this.snapshot();
    },
  };
  let override = null;
  const calls = [];
  const automationEngine = {
    activateManualOverride(aircoId, options) {
      calls.push(["activate", aircoId, options.source]);
      override ||= { aircoId, startedAt: "2026-08-16T08:00:00.000Z", source: options.source };
      return override;
    },
    clearManualOverride(aircoId) {
      calls.push(["clear", aircoId]);
      override = null;
    },
    manualOverride: () => override,
  };
  const manager = { get: () => runtime, list: () => [runtime.snapshot()] };
  const server = createServer(manager, { automationEngine });

  const switchedOn = await dispatch(server, {
    method: "POST",
    url: "/api/aircos/living-room/power",
    body: JSON.stringify({ power: "on" }),
  });
  assert.equal(switchedOn.statusCode, 200);
  assert.equal(JSON.parse(switchedOn.body).automationOverride.source, "power");

  const list = await dispatch(server, { url: "/api/aircos" });
  assert.equal(JSON.parse(list.body).aircos[0].automationOverride.aircoId, "living-room");

  const resumed = await dispatch(server, {
    method: "POST",
    url: "/api/aircos/living-room/automation-override",
    body: JSON.stringify({ active: false }),
  });
  assert.equal(resumed.statusCode, 200);
  assert.equal(JSON.parse(resumed.body).automationOverride, null);

  await dispatch(server, {
    method: "POST",
    url: "/api/aircos/living-room/power",
    body: JSON.stringify({ power: "on", automationOverride: false }),
  });
  assert.deepEqual(calls, [
    ["activate", "living-room", "power"],
    ["clear", "living-room"],
  ]);
});

test("server exposes automation CRUD and the temperature shortcut", async () => {
  const calls = [];
  const automation = { id: "automation-1", name: "Warm day", nodes: [], edges: [] };
  const automationEngine = {
    logStore: {},
    list: () => [automation],
    get: (id) => ({ ...automation, id }),
    create: (body) => (calls.push(["create", body]), automation),
    update: (id, body) => (calls.push(["update", id, body]), { ...automation, ...body }),
    remove: (id) => (calls.push(["remove", id]), automation),
    createTemperatureShortcut: (body) => (calls.push(["shortcut", body]), automation),
    listLog: (options) => (calls.push(["list-log", options]), [{ id: "entry-1" }]),
    clearLog: () => (calls.push(["clear-log"]), 1),
  };
  const manager = { list: () => [] };
  const server = createServer(manager, { automationEngine });

  const list = await dispatch(server, { url: "/api/automations" });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(JSON.parse(list.body), { automations: [automation] });

  const activity = await dispatch(server, { url: "/api/automation-log?limit=25" });
  assert.equal(activity.statusCode, 200);
  assert.deepEqual(JSON.parse(activity.body), { entries: [{ id: "entry-1" }] });

  const clearActivity = await dispatch(server, { method: "DELETE", url: "/api/automation-log" });
  assert.equal(clearActivity.statusCode, 200);
  assert.deepEqual(JSON.parse(clearActivity.body), { removed: 1 });

  const create = await dispatch(server, {
    method: "POST",
    url: "/api/automations",
    body: JSON.stringify({ name: "Warm day" }),
  });
  assert.equal(create.statusCode, 201);

  const update = await dispatch(server, {
    method: "PUT",
    url: "/api/automations/automation-1",
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(update.statusCode, 200);

  const shortcut = await dispatch(server, {
    method: "POST",
    url: "/api/automations/temperature-shortcut",
    body: JSON.stringify({ aircoId: "living-room" }),
  });
  assert.equal(shortcut.statusCode, 201);

  const remove = await dispatch(server, { method: "DELETE", url: "/api/automations/automation-1" });
  assert.equal(remove.statusCode, 200);
  assert.deepEqual(calls.map((call) => call[0]), ["list-log", "clear-log", "create", "update", "shortcut", "remove"]);
});

test("server exposes discovered WF-RAC units and marks configured addresses", async () => {
  const existingDiscoveryId = "a".repeat(64);
  const newDiscoveryId = "b".repeat(64);
  const manager = {
    configs: () => [{ ip: "192.168.1.50", port: 51443, discoveryId: existingDiscoveryId }],
  };
  const unitDiscoverer = async () => [
    { name: "Mitsubishi WF-RAC existing", discoveryId: existingDiscoveryId, ip: "192.168.1.50", port: 51443 },
    { name: "Mitsubishi WF-RAC new", discoveryId: newDiscoveryId, ip: "192.168.1.198", port: 51443 },
  ];
  const server = createServer(manager, { unitDiscoverer });

  const response = await dispatch(server, { url: "/api/setup/discover" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    units: [
      {
        name: "Mitsubishi WF-RAC existing",
        discoveryId: existingDiscoveryId,
        ip: "192.168.1.50",
        port: 51443,
        configured: true,
      },
      {
        name: "Mitsubishi WF-RAC new",
        discoveryId: newDiscoveryId,
        ip: "192.168.1.198",
        port: 51443,
        configured: false,
      },
    ],
  });

  const infoResponse = await dispatch(server, { url: "/api/info" });
  assert.equal(JSON.parse(infoResponse.body).features.unitDiscovery, true);
});

test("server saves a global preset per air conditioner and applies it separately", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airco-server-presets-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const presetStore = new PresetStore(path.join(directory, "presets.json"));

  const sourceStatus = new WfracStatus()
    .setPower(true)
    .setMode("cool")
    .setTargetTemp(20.5)
    .setAirFlow("highest")
    .setEntrust(false)
    .setWindDirectionUD(3)
    .setWindDirectionLR(6)
    .setPower(false);
  sourceStatus.coolHotJudge = false;
  sourceStatus.setVacantProperty(true);

  const applied = {};
  function runtime(id) {
    return {
      config: { id },
      vacantPresetRestoreState: {},
      snapshot: () => ({ status: sourceStatus.toJSON() }),
      async update(mutator) {
        const status = new WfracStatus();
        mutator(status);
        applied[id] = status.toJSON();
        return { airco: { id }, status: applied[id] };
      },
    };
  }

  const runtimes = {
    "living-room": runtime("living-room"),
    bedroom: runtime("bedroom"),
  };
  const manager = {
    get: (id) => runtimes[id],
    configs: () => Object.keys(runtimes).map((id) => ({ id })),
  };
  const server = createServer(manager, { presetStore });

  const saveResponse = await dispatch(server, {
    method: "POST",
    url: "/api/aircos/living-room/presets",
    body: JSON.stringify({ name: "Summer evening", global: true }),
  });
  assert.equal(saveResponse.statusCode, 201);
  assert.equal(presetStore.list("living-room").length, 1);
  assert.equal(presetStore.list("bedroom").length, 1);

  const bedroomPreset = presetStore.list("bedroom")[0];
  const snapshotResponse = await dispatch(server, {
    url: "/api/aircos/bedroom",
  });
  assert.equal(snapshotResponse.statusCode, 200);
  const snapshot = JSON.parse(snapshotResponse.body);
  assert.equal(Object.hasOwn(snapshot, "presets"), true);
  assert.deepEqual(snapshot.presets, [bedroomPreset]);

  const applyResponse = await dispatch(server, {
    method: "POST",
    url: `/api/aircos/bedroom/presets/${bedroomPreset.id}/apply`,
    body: "{}",
  });
  assert.equal(applyResponse.statusCode, 200);
  assert.equal(applied.bedroom.power, "on");
  assert.equal(applied.bedroom.presetTemp, 20.5);
  assert.equal(applied.bedroom.operationModeName, "cool");
  assert.equal(applied.bedroom.airFlowName, "highest");
  assert.equal(applied.bedroom.windDirectionUD, 3);
  assert.equal(applied.bedroom.windDirectionLR, 6);
  assert.equal(applied.bedroom.entrust, false);
  assert.equal(applied.bedroom.coolHotJudge, false);
  assert.equal(applied.bedroom.isVacantProperty, 1);
  assert.equal(runtimes.bedroom.vacantPresetRestoreState, null);
  assert.equal(applied["living-room"], undefined);
});
