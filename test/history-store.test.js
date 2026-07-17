"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { HistoryStore } = require("../src/history-store");

test("history records a completed power session", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airco-history-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const store = new HistoryStore(path.join(directory, "history.json"));
  const startedAt = new Date("2026-01-15T12:00:00.000Z");
  const endedAt = new Date("2026-01-15T13:00:00.000Z");

  store.recordPoll("test-unit", { operation: true, electric: 0 }, startedAt);
  store.recordPoll("test-unit", { operation: true, electric: 0.5 }, endedAt);
  const summary = store.recordPoll("test-unit", { operation: false, electric: 0.5 }, endedAt);

  assert.equal(summary.lastSession.energyKwh, 0.5);
  assert.equal(summary.lastSession.durationMs, 3_600_000);
  assert.ok(Math.abs(summary.lastSession.averageWatts - 500) < 1e-9);
  assert.ok(Math.abs(summary.currentWatts - 500) < 1e-9);
  assert.equal(summary.sessions.length, 1);
});
