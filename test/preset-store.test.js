"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { PresetStore } = require("../src/preset-store");

const SETTINGS = {
  power: true,
  temperature: 20.5,
  mode: "cool",
  airflow: "high",
  windDirectionUD: 2,
  windDirectionLR: 6,
  entrust: false,
  coolHotJudge: true,
  vacant: false,
};

test("presets are copied and persisted independently per air conditioner", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airco-presets-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "presets.json");

  const store = new PresetStore(file);
  const created = store.createMany(["living-room", "bedroom"], "Sleep", SETTINGS);

  assert.equal(created.length, 2);
  assert.notEqual(created[0].preset.id, created[1].preset.id);
  assert.deepEqual(store.list("living-room")[0].settings, SETTINGS);
  assert.deepEqual(store.list("bedroom")[0].settings, SETTINGS);

  store.remove("living-room", created[0].preset.id);
  assert.deepEqual(store.list("living-room"), []);
  assert.equal(store.list("bedroom").length, 1);

  const reloaded = new PresetStore(file);
  assert.deepEqual(reloaded.list("living-room"), []);
  assert.equal(reloaded.list("bedroom")[0].name, "Sleep");
});

test("a duplicate global preset is rejected without partially copying it", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airco-presets-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new PresetStore(path.join(directory, "presets.json"));

  store.createMany(["living-room"], "Sleep", SETTINGS);
  assert.throws(
    () => store.createMany(["bedroom", "living-room"], "sleep", SETTINGS),
    (error) => error.statusCode === 409
  );
  assert.deepEqual(store.list("bedroom"), []);
  assert.equal(store.list("living-room").length, 1);
});

test("a preset captured while off is normalized to turn the unit on", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airco-presets-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new PresetStore(path.join(directory, "presets.json"));

  store.createMany(["living-room"], "Start cooling", { ...SETTINGS, power: false });
  assert.equal(store.list("living-room")[0].settings.power, true);
});
