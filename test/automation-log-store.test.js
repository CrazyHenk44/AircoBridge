"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { AutomationLogStore } = require("../src/automation-log-store");

test("automation activity is persisted, filtered and bounded", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airco-automation-log-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "activity.json");
  const store = new AutomationLogStore(file, 3);

  for (let index = 1; index <= 4; index += 1) {
    store.append({
      time: new Date(`2026-08-13T20:0${index}:00.000Z`),
      automationId: index === 4 ? "bedroom" : "living-room",
      automationName: "Temperature control",
      event: "action-executed",
      title: `Action ${index}`,
      conditions: [{ nodeId: "temp", type: "temperature", result: true, message: "Indoor is warm", actual: 25.5 }],
    });
  }

  const reloaded = new AutomationLogStore(file, 3);
  assert.deepEqual(reloaded.list().map((entry) => entry.title), ["Action 4", "Action 3", "Action 2"]);
  assert.deepEqual(reloaded.list({ automationId: "living-room" }).map((entry) => entry.title), ["Action 3", "Action 2"]);
  assert.equal(reloaded.list()[0].conditions[0].actual, 25.5);
  assert.equal(reloaded.clear(), 3);
  assert.deepEqual(reloaded.list(), []);
});
