"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { AutomationStore, temperatureShortcutGraph } = require("../src/automation-store");

test("automation store persists a connected graph", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airco-automation-store-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "automations.json");
  const store = new AutomationStore(file);
  const graph = temperatureShortcutGraph({
    aircoId: "living-room",
    presetId: "cool-25",
    startTemperature: 25,
    stopStrategy: "outdoor",
    stopTemperature: 24.5,
  });

  const created = store.create({ name: "Warm day", enabled: true, cooldownSeconds: 0, ...graph });
  assert.equal("cooldownSeconds" in created, false);
  assert.equal(created.nodes.filter((node) => node.type === "and").length, 2);
  assert.equal(created.nodes.filter((node) => node.type === "apply-preset").length, 1);
  assert.equal(created.nodes.filter((node) => node.type === "set-power").length, 1);
  assert.equal(created.nodes.filter((node) => node.type === "mode").length, 1);
  const indoor = created.nodes.find((node) => node.type === "temperature" && node.config.sensor === "indoor");
  const outdoorStart = created.nodes.find((node) => node.type === "temperature" && node.config.operator === "gte");
  const powerOffCondition = created.nodes.find((node) => node.type === "power" && node.config.state === "off");
  const powerOnCondition = created.nodes.find((node) => node.type === "power" && node.config.state === "on");
  const modeCondition = created.nodes.find((node) => node.type === "mode");
  const powerAction = created.nodes.find((node) => node.type === "set-power");
  assert.deepEqual(indoor.position, { x: 70, y: 70 });
  assert.deepEqual(outdoorStart.position, { x: 350, y: 70 });
  assert.equal(outdoorStart.config.value, 26);
  assert.deepEqual(powerOffCondition.position, { x: 70, y: 340 });
  assert.equal(powerOffCondition.config.durationMinutes, 0);
  assert.equal(powerOnCondition.config.durationMinutes, 30);
  assert.deepEqual(modeCondition.config, { aircoId: "living-room", mode: "cool" });
  assert.deepEqual(powerAction.config, {
    aircoId: "living-room", state: "clean", durationMinutes: 30,
  });

  const reloaded = new AutomationStore(file).get(created.id);
  assert.equal(reloaded.name, "Warm day");
  assert.deepEqual(reloaded.edges, created.edges);

  const cleanNodes = created.nodes.map((node) => node.type === "set-power"
    ? { ...node, config: { ...node.config, state: "clean", durationMinutes: 30 } }
    : node);
  const withClean = store.update(created.id, { nodes: cleanNodes });
  assert.deepEqual(
    withClean.nodes.find((node) => node.type === "set-power").config,
    { aircoId: "living-room", state: "clean", durationMinutes: 30 }
  );

  store.setPendingClean({
    aircoId: "living-room",
    automationId: created.id,
    automationName: created.name,
    actionNodeId: "clean-action",
    durationMinutes: 30,
    startedAt: "2026-08-14T08:00:00.000Z",
    endsAt: "2026-08-14T08:30:00.000Z",
  });
  assert.equal(new AutomationStore(file).listPendingCleans()[0].endsAt, "2026-08-14T08:30:00.000Z");
  assert.equal(store.removePendingClean("living-room").actionNodeId, "clean-action");

  store.setManualOverride({
    aircoId: "living-room",
    startedAt: "2026-08-14T09:00:00.000Z",
    source: "power",
  });
  const manualOverride = new AutomationStore(file).getManualOverride("living-room");
  assert.deepEqual(manualOverride, {
    aircoId: "living-room",
    startedAt: "2026-08-14T09:00:00.000Z",
    source: "power",
  });
  assert.equal(store.setManualOverride({
    aircoId: "living-room",
    startedAt: "2026-08-14T10:00:00.000Z",
    source: "settings",
  }).startedAt, manualOverride.startedAt);
  assert.equal(store.removeManualOverride("living-room").source, "power");
  assert.deepEqual(store.listManualOverrides(), []);

  const updated = store.update(created.id, { enabled: false, name: "Summer control" });
  assert.equal(updated.enabled, false);
  assert.equal(updated.name, "Summer control");
  assert.equal(store.remove(created.id).id, created.id);
  assert.deepEqual(store.list(), []);
});

test("automation store rejects invalid connections and shortcut thresholds", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airco-automation-validation-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new AutomationStore(path.join(directory, "automations.json"));

  assert.throws(() => store.create({
    name: "Loop",
    nodes: [
      { id: "and-1", type: "and", position: { x: 0, y: 0 } },
      { id: "or-1", type: "or", position: { x: 100, y: 0 } },
    ],
    edges: [
      { id: "a", from: "and-1", to: "or-1" },
      { id: "b", from: "or-1", to: "and-1" },
    ],
  }), /loop/);

  assert.throws(() => temperatureShortcutGraph({
    aircoId: "living-room",
    presetId: "cool-25",
    startTemperature: 25,
    stopStrategy: "indoor",
    stopTemperature: 25,
  }), /lower/);

  assert.throws(() => store.create({
    name: "Invalid clean duration",
    nodes: [
      { id: "time", type: "time", position: { x: 0, y: 0 }, config: { start: "08:00", end: "09:00" } },
      { id: "action", type: "set-power", position: { x: 300, y: 0 }, config: {
        aircoId: "living-room", state: "clean", durationMinutes: 0,
      } },
    ],
    edges: [{ id: "edge", from: "time", to: "action" }],
  }), /duration/);

  assert.throws(() => store.create({
    name: "Invalid power duration",
    nodes: [{ id: "power", type: "power", position: { x: 0, y: 0 }, config: {
      aircoId: "living-room", state: "on", durationMinutes: 10081,
    } }],
    edges: [],
  }), /duration/);

  assert.throws(() => store.create({
    name: "Invalid mode",
    nodes: [{ id: "mode", type: "mode", position: { x: 0, y: 0 }, config: {
      aircoId: "living-room", mode: "ventilate",
    } }],
    edges: [],
  }), /mode/);
});
