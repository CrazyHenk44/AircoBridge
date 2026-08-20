"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { AutomationEngine } = require("../src/automation-engine");
const { AutomationLogStore } = require("../src/automation-log-store");
const { AutomationStore, temperatureShortcutGraph } = require("../src/automation-store");
const { PresetStore } = require("../src/preset-store");
const { WfracStatus } = require("../src/wfrac");

function settings() {
  return {
    temperature: 25,
    mode: "cool",
    airflow: "auto",
    windDirectionUD: 0,
    windDirectionLR: 0,
    entrust: false,
    coolHotJudge: true,
    vacant: false,
  };
}

test("automation engine evaluates AND branches and runs the paired temperature shortcut", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airco-automation-engine-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const automationStore = new AutomationStore(path.join(directory, "automations.json"));
  const logStore = new AutomationLogStore(path.join(directory, "activity.json"));
  const presetStore = new PresetStore(path.join(directory, "presets.json"));
  const preset = presetStore.createMany(["living-room"], "Cool 25", settings())[0].preset;
  const status = new WfracStatus();
  status.indoorTemp = 26;
  status.outdoorTemp = 26;
  status.setPower(false);
  let writes = 0;
  let now = new Date("2026-08-13T12:00:00.000Z");
  let powerChangedAt = now.toISOString();
  const runtime = {
    config: { id: "living-room" },
    vacantPresetRestoreState: {},
    snapshot: () => ({
      online: true,
      status: status.toJSON(),
      history: {
        powerChangedAt,
        currentSession: status.operation ? { startedAt: powerChangedAt } : null,
      },
    }),
    async update(mutator) {
      const wasOn = status.operation;
      mutator(status);
      if (wasOn !== status.operation) powerChangedAt = now.toISOString();
      writes += 1;
      return this.snapshot();
    },
  };
  const manager = { get: (id) => {
    if (id !== "living-room") throw Object.assign(new Error("Unknown air conditioner"), { statusCode: 404 });
    return runtime;
  } };
  const engine = new AutomationEngine(manager, presetStore, automationStore, { now: () => now, logStore });
  const graph = temperatureShortcutGraph({
    aircoId: "living-room",
    presetId: preset.id,
    startTemperature: 25,
    stopStrategy: "outdoor",
    stopTemperature: 24.5,
    outdoorHysteresis: 1.5,
  });
  automationStore.create({ name: "Temperature control", ...graph });

  await engine.evaluateAll();
  assert.equal(status.operation, true);
  assert.equal(status.presetTemp, 25);
  assert.equal(writes, 1);

  now = new Date("2026-08-13T12:01:00.000Z");
  await engine.evaluateAll();
  assert.equal(writes, 1);

  status.outdoorTemp = 24;
  now = new Date("2026-08-13T12:02:00.000Z");
  status.setMode("fan");
  engine.acknowledgeControlState("living-room");
  await engine.evaluateAll();
  assert.equal(status.operation, true);
  assert.equal(writes, 1);

  now = new Date("2026-08-13T12:03:00.000Z");
  status.setMode("cool");
  engine.acknowledgeControlState("living-room");
  await engine.evaluateAll();
  assert.equal(status.operation, true);
  assert.equal(writes, 1);

  now = new Date("2026-08-13T12:30:00.000Z");
  await engine.evaluateAll();
  assert.equal(status.operation, true);
  assert.equal(status.toJSON().operationModeName, "fan");
  assert.equal(writes, 2);
  assert.equal(automationStore.listPendingCleans().length, 1);

  const automation = engine.list()[0];
  assert.equal(automation.runtime.lastTriggeredAt, now.toISOString());
  assert.equal(Object.keys(automation.runtime.actionStates).length, 2);
  const modeNode = automation.nodes.find((node) => node.type === "mode");
  assert.equal(automation.runtime.nodeStates[modeNode.id].result, true);
  assert.equal(automation.runtime.nodeStates[modeNode.id].actual, "cool");
  let activity = logStore.list();
  assert.equal(activity.length, 2);
  assert.match(activity[0].title, /clean cycle started/i);
  assert.match(activity[1].title, /Cool 25/);
  assert.equal(activity[1].conditions.some((condition) => condition.actual === 26), true);

  now = new Date("2026-08-13T13:00:00.000Z");
  await engine.evaluateAll();
  assert.equal(status.operation, false);
  assert.equal(writes, 3);
  assert.equal(automationStore.listPendingCleans().length, 0);
  activity = logStore.list();
  assert.equal(activity.length, 3);
  assert.match(activity[0].title, /clean cycle completed/i);
});

test("automation engine keeps an action waiting when sensor data is unavailable", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airco-automation-wait-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const automationStore = new AutomationStore(path.join(directory, "automations.json"));
  const presetStore = new PresetStore(path.join(directory, "presets.json"));
  const preset = presetStore.createMany(["living-room"], "Cool 25", settings())[0].preset;
  const graph = temperatureShortcutGraph({
    aircoId: "living-room",
    presetId: preset.id,
    startTemperature: 25,
    stopStrategy: "none",
  });
  automationStore.create({ name: "Temperature control", ...graph });
  const manager = {
    get: () => ({
      config: { id: "living-room" },
      snapshot: () => ({ online: false, status: { indoorTemp: 30, power: "off" } }),
    }),
  };
  const engine = new AutomationEngine(manager, presetStore, automationStore);

  await engine.evaluateAll();
  assert.equal(engine.list()[0].runtime.status, "waiting");
  assert.match(engine.list()[0].runtime.message, /offline|waiting/i);
});

test("disabled automation evaluates conditions without executing actions", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airco-disabled-preview-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const automationStore = new AutomationStore(path.join(directory, "automations.json"));
  const presetStore = new PresetStore(path.join(directory, "presets.json"));
  const status = new WfracStatus();
  status.setPower(true);
  let writes = 0;
  const runtime = {
    config: { id: "living-room" },
    snapshot: () => ({ online: true, status: status.toJSON() }),
    async update(mutator) {
      await mutator(status);
      writes += 1;
    },
  };
  const manager = { get: () => runtime };
  const created = automationStore.create({
    name: "Disabled preview",
    enabled: false,
    nodes: [
      { id: "is-on", type: "power", position: { x: 0, y: 0 }, config: { aircoId: "living-room", state: "on" } },
      { id: "turn-off", type: "set-power", position: { x: 300, y: 0 }, config: { aircoId: "living-room", state: "off" } },
    ],
    edges: [{ id: "edge", from: "is-on", to: "turn-off" }],
  });
  const engine = new AutomationEngine(manager, presetStore, automationStore);

  await engine.evaluateAll();
  let preview = engine.get(created.id);
  assert.equal(writes, 0);
  assert.equal(status.operation, true);
  assert.equal(preview.runtime.status, "disabled");
  assert.equal(preview.runtime.nodeStates["is-on"].result, true);
  assert.equal(preview.runtime.actionStates["turn-off"].result, true);

  status.setPower(false);
  await engine.evaluateAll();
  preview = engine.get(created.id);
  assert.equal(writes, 0);
  assert.equal(preview.runtime.nodeStates["is-on"].result, false);
  assert.equal(preview.runtime.actionStates["turn-off"].result, false);
});

test("power condition waits until the current state has lasted for its minimum duration", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airco-power-duration-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const automationStore = new AutomationStore(path.join(directory, "automations.json"));
  const presetStore = new PresetStore(path.join(directory, "presets.json"));
  const status = new WfracStatus();
  status.setPower(true);
  let writes = 0;
  const runtime = {
    config: { id: "living-room" },
    snapshot: () => ({
      online: true,
      status: status.toJSON(),
      history: {
        powerChangedAt: "2026-08-16T12:00:00.000Z",
        currentSession: { startedAt: "2026-08-16T12:00:00.000Z" },
      },
    }),
    async update(mutator) {
      await mutator(status);
      writes += 1;
      return this.snapshot();
    },
  };
  const manager = { get: () => runtime };
  let now = new Date("2026-08-16T12:59:59.000Z");
  const created = automationStore.create({
    name: "Minimum runtime",
    enabled: true,
    nodes: [
      { id: "is-on", type: "power", position: { x: 0, y: 0 }, config: {
        aircoId: "living-room", state: "on", durationMinutes: 60,
      } },
      { id: "turn-off", type: "set-power", position: { x: 300, y: 0 }, config: {
        aircoId: "living-room", state: "off",
      } },
    ],
    edges: [{ id: "edge", from: "is-on", to: "turn-off" }],
  });
  const engine = new AutomationEngine(manager, presetStore, automationStore, { now: () => now });

  await engine.evaluateAll();
  assert.equal(writes, 0);
  assert.equal(engine.get(created.id).runtime.nodeStates["is-on"].result, false);

  now = new Date("2026-08-16T13:00:00.000Z");
  await engine.evaluateAll();
  assert.equal(writes, 1);
  assert.equal(status.operation, false);
  assert.equal(engine.get(created.id).runtime.nodeStates["is-on"].result, true);
});

test("automation actions always use the internal five-minute cooldown", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airco-fixed-cooldown-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const automationStore = new AutomationStore(path.join(directory, "automations.json"));
  const presetStore = new PresetStore(path.join(directory, "presets.json"));
  const status = new WfracStatus();
  status.indoorTemp = 26;
  status.setPower(false);
  let writes = 0;
  const runtime = {
    config: { id: "living-room" },
    snapshot: () => ({ online: true, status: status.toJSON() }),
    async update(mutator) {
      await mutator(status);
      writes += 1;
      return this.snapshot();
    },
  };
  const manager = { get: () => runtime };
  let now = new Date("2026-08-16T12:00:00.000Z");
  const created = automationStore.create({
    name: "Fixed cooldown",
    enabled: true,
    cooldownSeconds: 0,
    nodes: [
      { id: "hot", type: "temperature", position: { x: 0, y: 0 }, config: {
        aircoId: "living-room", sensor: "indoor", operator: "gt", value: 25,
      } },
      { id: "power-on", type: "set-power", position: { x: 300, y: 0 }, config: {
        aircoId: "living-room", state: "on",
      } },
    ],
    edges: [{ id: "edge", from: "hot", to: "power-on" }],
  });
  assert.equal("cooldownSeconds" in created, false);
  const engine = new AutomationEngine(manager, presetStore, automationStore, { now: () => now });

  await engine.evaluateAll();
  assert.equal(writes, 1);

  status.indoorTemp = 24;
  now = new Date("2026-08-16T12:01:00.000Z");
  await engine.evaluateAll();
  status.indoorTemp = 26;
  now = new Date("2026-08-16T12:02:00.000Z");
  await engine.evaluateAll();
  assert.equal(writes, 1);
  assert.match(engine.get(created.id).runtime.actionStates["power-on"].message, /cooldown/i);

  now = new Date("2026-08-16T12:05:01.000Z");
  await engine.evaluateAll();
  assert.equal(writes, 2);
});

test("manual control persistently pauses actions and resumes without disabling the flow", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airco-manual-override-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const automationFile = path.join(directory, "automations.json");
  const automationStore = new AutomationStore(automationFile);
  const presetStore = new PresetStore(path.join(directory, "presets.json"));
  const status = new WfracStatus();
  status.indoorTemp = 27;
  status.setPower(true);
  let writes = 0;
  const runtime = {
    config: { id: "living-room" },
    snapshot: () => ({ online: true, status: status.toJSON() }),
    async update(mutator) {
      await mutator(status);
      writes += 1;
      return this.snapshot();
    },
  };
  const manager = { get: () => runtime };
  const created = automationStore.create({
    name: "Stop when outdoor is cool",
    enabled: true,
    nodes: [
      { id: "hot", type: "temperature", position: { x: 0, y: 0 }, config: {
        aircoId: "living-room", sensor: "indoor", operator: "gt", value: 25,
      } },
      { id: "off", type: "set-power", position: { x: 300, y: 0 }, config: {
        aircoId: "living-room", state: "off",
      } },
    ],
    edges: [{ id: "edge", from: "hot", to: "off" }],
  });
  const now = new Date("2026-08-16T08:00:00.000Z");
  const engine = new AutomationEngine(manager, presetStore, automationStore, { now: () => now });

  engine.activateManualOverride("living-room", { source: "power" });
  assert.equal(new AutomationStore(automationFile).getManualOverride("living-room").source, "power");
  await engine.evaluateAll();

  const paused = engine.get(created.id);
  assert.equal(writes, 0);
  assert.equal(status.operation, true);
  assert.equal(paused.runtime.status, "overridden");
  assert.equal(paused.runtime.actionStates.off.manualOverride.aircoId, "living-room");

  engine.clearManualOverride("living-room");
  await engine.evaluateAll();
  assert.equal(writes, 1);
  assert.equal(status.operation, false);
  assert.equal(engine.manualOverride("living-room"), null);
});

test("manual control automatically ends once the unit is off", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airco-manual-off-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const automationStore = new AutomationStore(path.join(directory, "automations.json"));
  const presetStore = new PresetStore(path.join(directory, "presets.json"));
  const status = new WfracStatus();
  status.setPower(false);
  const runtime = {
    config: { id: "living-room" },
    snapshot: () => ({ online: true, status: status.toJSON() }),
  };
  const engine = new AutomationEngine({ get: () => runtime }, presetStore, automationStore);

  engine.activateManualOverride("living-room");
  await engine.evaluateAll();
  assert.equal(engine.manualOverride("living-room"), null);
});

test("a physical remote control change is detected before automation actions run", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airco-remote-control-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const automationStore = new AutomationStore(path.join(directory, "automations.json"));
  const presetStore = new PresetStore(path.join(directory, "presets.json"));
  const status = new WfracStatus();
  status.setMode("cool");
  status.setPower(false);
  let writes = 0;
  const runtime = {
    config: { id: "living-room" },
    snapshot: () => ({ online: true, status: status.toJSON() }),
    async update(mutator) {
      await mutator(status);
      writes += 1;
      return this.snapshot();
    },
  };
  const manager = {
    configs: () => [{ id: "living-room" }],
    get: () => runtime,
  };
  const created = automationStore.create({
    name: "Automatic stop",
    enabled: true,
    nodes: [
      { id: "on", type: "power", position: { x: 0, y: 0 }, config: {
        aircoId: "living-room", state: "on",
      } },
      { id: "off", type: "set-power", position: { x: 300, y: 0 }, config: {
        aircoId: "living-room", state: "off",
      } },
    ],
    edges: [{ id: "edge", from: "on", to: "off" }],
  });
  const engine = new AutomationEngine(manager, presetStore, automationStore);

  await engine.evaluateAll();
  assert.equal(writes, 0);
  status.setPower(true); // Simulates a later status poll after using the physical remote.
  await engine.evaluateAll();

  assert.equal(writes, 0);
  assert.equal(status.operation, true);
  assert.equal(engine.manualOverride("living-room").source, "remote-control");
  assert.equal(engine.get(created.id).runtime.status, "overridden");
});

test("clean action runs the fan for 30 minutes and survives an engine restart", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airco-clean-action-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const automationFile = path.join(directory, "automations.json");
  const automationStore = new AutomationStore(automationFile);
  const logStore = new AutomationLogStore(path.join(directory, "activity.json"));
  const presetStore = new PresetStore(path.join(directory, "presets.json"));
  const status = new WfracStatus();
  status.setMode("cool");
  status.setAirFlow("auto");
  let writes = 0;
  const runtime = {
    config: { id: "living-room" },
    managedSelfClean: null,
    snapshot: () => ({ online: true, status: status.toJSON() }),
    setManagedSelfClean(value) {
      this.managedSelfClean = value;
    },
    async update(mutator) {
      await mutator(status);
      writes += 1;
      return this.snapshot();
    },
  };
  const manager = { get: () => runtime };
  let now = new Date("2026-08-14T08:00:00.000Z");
  automationStore.create({
    name: "Dry after cooling",
    enabled: true,
    nodes: [
      { id: "is-on", type: "power", position: { x: 50, y: 50 }, config: { aircoId: "living-room", state: "on" } },
      { id: "clean", type: "set-power", position: { x: 400, y: 50 }, config: {
        aircoId: "living-room", state: "clean", durationMinutes: 30,
      } },
    ],
    edges: [{ id: "edge", from: "is-on", to: "clean" }],
  });
  const firstEngine = new AutomationEngine(manager, presetStore, automationStore, { now: () => now, logStore });

  await firstEngine.evaluateAll();
  assert.equal(status.operation, true);
  assert.equal(status.toJSON().operationModeName, "fan");
  assert.equal(status.toJSON().airFlowName, "low");
  assert.equal(runtime.managedSelfClean.endsAt, "2026-08-14T08:30:00.000Z");
  assert.equal(writes, 1);
  assert.equal(automationStore.listPendingCleans()[0].endsAt, "2026-08-14T08:30:00.000Z");

  now = new Date("2026-08-14T08:31:00.000Z");
  const reloadedStore = new AutomationStore(automationFile);
  const restartedEngine = new AutomationEngine(manager, presetStore, reloadedStore, { now: () => now, logStore });
  await restartedEngine.evaluateAll();

  assert.equal(status.operation, false);
  assert.equal(runtime.managedSelfClean, null);
  assert.equal(writes, 2);
  assert.deepEqual(reloadedStore.listPendingCleans(), []);
  assert.match(logStore.list()[0].title, /completed/i);
});

test("a clean action retrigger does not interrupt or restart an active clean cycle", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airco-clean-retrigger-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const automationStore = new AutomationStore(path.join(directory, "automations.json"));
  const logStore = new AutomationLogStore(path.join(directory, "activity.json"));
  const presetStore = new PresetStore(path.join(directory, "presets.json"));
  const status = new WfracStatus();
  status.setMode("cool");
  status.setPower(true);
  let writes = 0;
  const runtime = {
    config: { id: "living-room" },
    managedSelfClean: null,
    snapshot: () => ({ online: true, status: status.toJSON() }),
    setManagedSelfClean(value) {
      this.managedSelfClean = value;
    },
    async update(mutator) {
      await mutator(status);
      writes += 1;
      return this.snapshot();
    },
  };
  const manager = { get: () => runtime };
  let now = new Date(2026, 7, 15, 22, 45);
  automationStore.create({
    name: "Clean before night",
    enabled: true,
    nodes: [
      { id: "cool", type: "mode", position: { x: 0, y: 0 }, config: { aircoId: "living-room", mode: "cool" } },
      { id: "night", type: "time", position: { x: 0, y: 250 }, config: {
        start: "23:00", end: "08:00", days: [0, 1, 2, 3, 4, 5, 6],
      } },
      { id: "stop", type: "or", position: { x: 300, y: 100 }, config: {} },
      { id: "clean", type: "set-power", position: { x: 600, y: 100 }, config: {
        aircoId: "living-room", state: "clean", durationMinutes: 30,
      } },
    ],
    edges: [
      { id: "cool-stop", from: "cool", to: "stop" },
      { id: "night-stop", from: "night", to: "stop" },
      { id: "run-clean", from: "stop", to: "clean" },
    ],
  });
  const engine = new AutomationEngine(manager, presetStore, automationStore, { now: () => now, logStore });

  await engine.evaluateAll();
  const originalEnd = automationStore.listPendingCleans()[0].endsAt;
  assert.equal(writes, 1);
  assert.equal(status.toJSON().operationModeName, "fan");

  now = new Date(2026, 7, 15, 22, 46);
  await engine.evaluateAll();
  now = new Date(2026, 7, 15, 23, 0);
  await engine.evaluateAll();

  assert.equal(writes, 1);
  assert.equal(status.operation, true);
  assert.equal(status.toJSON().operationModeName, "fan");
  assert.equal(automationStore.listPendingCleans()[0].endsAt, originalEnd);
  assert.equal(runtime.managedSelfClean.endsAt, originalEnd);
  assert.match(logStore.list()[0].title, /already in progress/i);
  assert.equal(logStore.list()[0].event, "action-skipped");
});

test("clean action is skipped after heat or fan mode", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airco-clean-skip-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  for (const mode of ["heat", "fan"]) {
    const automationStore = new AutomationStore(path.join(directory, `${mode}-automations.json`));
    const presetStore = new PresetStore(path.join(directory, `${mode}-presets.json`));
    const status = new WfracStatus();
    status.setMode(mode);
    const runtime = {
      config: { id: "living-room" },
      managedSelfClean: { endsAt: "2026-08-14T09:00:00.000Z" },
      setManagedSelfClean(value) {
        this.managedSelfClean = value;
      },
      async update(mutator) {
        await mutator(status);
      },
    };
    const manager = { get: () => runtime };
    const engine = new AutomationEngine(manager, presetStore, automationStore, {
      now: () => new Date("2026-08-14T08:00:00.000Z"),
    });
    const outcome = await engine.runAction({
      id: "clean",
      type: "set-power",
      config: { aircoId: "living-room", state: "clean", durationMinutes: 30 },
    }, { id: "flow", name: "Dry after cooling" });

    assert.equal(status.operation, false);
    assert.equal(status.toJSON().operationModeName, mode);
    assert.equal(runtime.managedSelfClean, null);
    assert.deepEqual(automationStore.listPendingCleans(), []);
    assert.equal(outcome.action.skipped, true);
    assert.equal(outcome.action.previousMode, mode);
  }
});
