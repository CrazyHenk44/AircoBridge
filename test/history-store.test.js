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
  const summary = store.recordPoll("test-unit", { operation: false, electric: 0 }, endedAt);

  assert.equal(summary.lastSession.energyKwh, 0.5);
  assert.equal(summary.lastSession.durationMs, 3_600_000);
  assert.ok(Math.abs(summary.lastSession.averageWatts - 500) < 1e-9);
  assert.equal(summary.currentWatts, 0);
  assert.equal(summary.totalKwh, 0.5);
  assert.equal(summary.sessions.length, 1);
});

test("history migrates a legacy monthly total", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airco-history-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const historyFile = path.join(directory, "history.json");
  fs.writeFileSync(historyFile, JSON.stringify({
    version: 1,
    aircos: {
      "test-unit": {
        monthly: {
          "2025-12": 4.5,
          "2026-01": 1.5,
        },
        sessions: [],
      },
    },
  }));

  const store = new HistoryStore(historyFile);
  const summary = store.summarize("test-unit", { operation: false, electric: 0 });
  assert.equal(store.state.version, 2);
  assert.equal(summary.totalKwh, 6);
});

test("history keeps total energy across a month boundary and restart", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airco-history-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const historyFile = path.join(directory, "history.json");
  const startedAt = new Date(2026, 0, 31, 23, 0, 0);
  const beforeBoundary = new Date(2026, 0, 31, 23, 59, 0);
  const afterBoundary = new Date(2026, 1, 1, 0, 1, 0);
  const endedAt = new Date(2026, 1, 1, 1, 0, 0);

  let store = new HistoryStore(historyFile);
  store.recordPoll("test-unit", { operation: true, electric: 0 }, startedAt);
  const before = store.recordPoll("test-unit", { operation: true, electric: 1 }, beforeBoundary);
  assert.equal(before.totalKwh, 1);

  store = new HistoryStore(historyFile);
  const after = store.recordPoll("test-unit", { operation: true, electric: 1.1 }, afterBoundary);
  assert.equal(after.totalKwh, 1.1);

  const completed = store.recordPoll("test-unit", { operation: false, electric: 2 }, endedAt);
  assert.equal(completed.totalKwh, 2);
  assert.ok(Math.abs(completed.monthly["2026-01"] - 1) < 1e-9);
  assert.ok(Math.abs(completed.monthly["2026-02"] - 1) < 1e-9);

  const reloaded = new HistoryStore(historyFile).summarize(
    "test-unit",
    { operation: false, electric: 0 },
    endedAt
  );
  assert.equal(reloaded.totalKwh, 2);
});

test("monthly and total energy survive more than 500 sessions", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airco-history-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const store = new HistoryStore(path.join(directory, "history.json"));
  store.save = () => {};
  const monthStart = new Date(2026, 2, 1, 0, 0, 0);
  let summary = null;

  for (let index = 0; index < 502; index += 1) {
    const startedAt = new Date(monthStart.getTime() + index * 120_000);
    const endedAt = new Date(startedAt.getTime() + 60_000);
    store.recordPoll("test-unit", { operation: true, electric: 0 }, startedAt);
    summary = store.recordPoll("test-unit", { operation: false, electric: 0.25 }, endedAt);
  }

  const expectedKwh = 502 * 0.25;
  assert.equal(summary.sessions.length, 50);
  assert.equal(store.entry("test-unit").sessions.length, 500);
  assert.ok(Math.abs(summary.monthTotalKwh - expectedKwh) < 1e-9);
  assert.ok(Math.abs(summary.totalKwh - expectedKwh) < 1e-9);
});

test("a retained counter becomes the baseline of a new run", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airco-history-baseline-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new HistoryStore(path.join(directory, "history.json"));
  const before = new Date("2026-08-15T09:00:00.000Z");
  const started = new Date("2026-08-15T10:00:00.000Z");

  store.recordPoll("test-unit", { operation: false, electric: 9.25 }, before);
  let summary = store.recordPoll("test-unit", { operation: true, electric: 9.25 }, started);
  assert.equal(summary.currentSession.energyKwh, 0);
  assert.equal(summary.currentWatts, null);

  summary = store.recordPoll("test-unit", { operation: true, electric: 0 }, new Date("2026-08-15T10:01:00.000Z"));
  assert.equal(summary.currentSession.energyKwh, 0);
  summary = store.recordPoll("test-unit", { operation: true, electric: 0.25 }, new Date("2026-08-15T10:31:00.000Z"));
  assert.equal(summary.currentSession.energyKwh, 0.25);

  summary = store.recordPoll("test-unit", { operation: false, electric: 0.25 }, new Date("2026-08-15T10:32:00.000Z"));
  assert.equal(summary.lastSession.energyKwh, 0.25);
  assert.equal(summary.totalKwh, 0.25);
});

test("an active legacy session is rebased instead of counting its stale value", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airco-history-rebase-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const historyFile = path.join(directory, "history.json");
  fs.writeFileSync(historyFile, JSON.stringify({
    version: 2,
    aircos: {
      "test-unit": {
        lastPowerState: "on",
        lastPowerOnAt: "2026-08-15T09:48:39.137Z",
        currentSession: {
          startedAt: "2026-08-15T09:48:39.137Z",
          lastSeenAt: "2026-08-15T09:48:39.137Z",
          energyKwh: 9.25,
        },
        completedEnergyKwh: 10,
        monthly: {},
        sessions: [],
      },
    },
  }));

  const store = new HistoryStore(historyFile);
  const summary = store.recordPoll(
    "test-unit",
    { operation: true, electric: 9.25 },
    new Date("2026-08-15T10:00:00.000Z")
  );
  assert.equal(summary.currentSession.energyKwh, 0);
  assert.equal(summary.totalKwh, 10);
});

test("history exposes direct operation-data wattage only while running", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "airco-history-watts-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new HistoryStore(path.join(directory, "history.json"));

  let summary = store.recordPoll("test-unit", {
    operation: true,
    electric: 0,
    operationData: { powerWatts: 378.8235294117647 },
  }, new Date("2026-08-16T10:00:00.000Z"));
  assert.equal(summary.currentWatts, 378.8235294117647);

  summary = store.recordPoll("test-unit", {
    operation: false,
    electric: 0,
    operationData: { powerWatts: 42 },
  }, new Date("2026-08-16T10:01:00.000Z"));
  assert.equal(summary.currentWatts, 0);
});
