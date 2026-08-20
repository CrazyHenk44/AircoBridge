"use strict";

const fs = require("fs");
const path = require("path");

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfLocalMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfLocalMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 1);
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function nonNegativeNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function overlapMs(start, end, bucketStart, bucketEnd) {
  const left = Math.max(start.getTime(), bucketStart.getTime());
  const right = Math.min(end.getTime(), bucketEnd.getTime());
  return Math.max(0, right - left);
}

function kwhToWatts(kwh, durationMs) {
  if (!Number.isFinite(kwh) || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  return (kwh / durationMs) * 3_600_000_000;
}

function trackSessionEnergy(session, electric) {
  let changed = false;
  if (session.counterTracking !== true) {
    // Older sessions treated the device's retained value as fresh consumption.
    // Start from the current counter instead; completed history is left untouched.
    session.counterTracking = true;
    session.energyKwh = electric == null ? null : 0;
    session.counterBaseline = electric;
    session.counterResetSeen = electric === 0;
    changed = true;
  }
  if (electric == null) return changed;

  let baseline = nonNegativeNumber(session.counterBaseline);
  if (baseline == null) {
    baseline = electric;
    session.counterBaseline = electric;
    session.counterResetSeen = electric === 0;
    if (session.energyKwh == null) session.energyKwh = 0;
    changed = true;
  }
  if (session.counterResetSeen !== true && electric < baseline) {
    session.counterResetSeen = true;
    changed = true;
  }

  const measuredEnergy = session.counterResetSeen === true
    ? electric
    : Math.max(0, electric - baseline);
  const previousEnergy = nonNegativeNumber(session.energyKwh);
  if (previousEnergy == null || measuredEnergy > previousEnergy) {
    session.energyKwh = measuredEnergy;
    changed = true;
  }
  return changed;
}

function energySliceForRange(session, rangeStart, rangeEnd) {
  const start = parseDate(session.startedAt);
  const end = parseDate(session.endedAt);
  const totalMs = start && end ? Math.max(0, end.getTime() - start.getTime()) : 0;
  if (!start || !end || totalMs <= 0) return 0;

  const shared = overlapMs(start, end, rangeStart, rangeEnd);
  if (shared <= 0) return 0;
  return (Number(session.energyKwh) || 0) * (shared / totalMs);
}

function normalizeSession(session) {
  return {
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    energyKwh: session.energyKwh,
    averageWatts: session.averageWatts ?? null,
    source: session.source || "poll",
  };
}

function normalizeEntry(entry) {
  entry.sessions = Array.isArray(entry.sessions) ? entry.sessions : [];
  entry.monthly = entry.monthly && typeof entry.monthly === "object" ? entry.monthly : {};
  const storedCompleted = nonNegativeNumber(entry.completedEnergyKwh);
  if (storedCompleted != null) {
    entry.completedEnergyKwh = storedCompleted;
  } else {
    const monthlyTotal = Object.values(entry.monthly).reduce(
      (sum, value) => sum + (nonNegativeNumber(value) ?? 0),
      0
    );
    const retainedSessionsTotal = entry.sessions.reduce(
      (sum, session) => sum + (nonNegativeNumber(session?.energyKwh) ?? 0),
      0
    );
    entry.completedEnergyKwh = Math.max(monthlyTotal, retainedSessionsTotal);
  }

  if (entry.currentSession && typeof entry.currentSession === "object") {
    entry.currentSession.energyKwh = nonNegativeNumber(entry.currentSession.energyKwh);
  }
  return entry;
}

function addSessionToMonthly(entry, session) {
  const start = parseDate(session.startedAt);
  const end = parseDate(session.endedAt);
  if (!start || !end || end <= start) return;

  for (
    let bucketStart = startOfLocalMonth(start);
    bucketStart < end;
    bucketStart = endOfLocalMonth(bucketStart)
  ) {
    const bucketEnd = endOfLocalMonth(bucketStart);
    const key = monthKey(bucketStart);
    const previous = nonNegativeNumber(entry.monthly[key]) ?? 0;
    entry.monthly[key] = previous + energySliceForRange(session, bucketStart, bucketEnd);
  }
}

class HistoryStore {
  constructor(filePath) {
    this.filePath = filePath || "data/airco-history.json";
    this.state = this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) {
        return { version: 2, aircos: {} };
      }
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!parsed || typeof parsed !== "object") throw new Error("Invalid history file");
      parsed.version = 2;
      parsed.aircos = parsed.aircos && typeof parsed.aircos === "object" ? parsed.aircos : {};
      for (const key of Object.keys(parsed.aircos)) normalizeEntry(parsed.aircos[key]);
      return parsed;
    } catch {
      return { version: 2, aircos: {} };
    }
  }

  save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`);
    fs.renameSync(tmp, this.filePath);
  }

  entry(id) {
    if (!this.state.aircos[id]) {
      this.state.aircos[id] = {
        lastPowerState: null,
        lastPowerChangedAt: null,
        lastPowerOnAt: null,
        lastPowerOffAt: null,
        currentSession: null,
        completedEnergyKwh: 0,
        monthly: {},
        sessions: [],
      };
    }
    return normalizeEntry(this.state.aircos[id]);
  }

  remove(id) {
    if (this.state.aircos[id]) {
      delete this.state.aircos[id];
      this.save();
    }
  }

  recordPoll(id, status, now = new Date()) {
    const entry = this.entry(id);
    const powerState = status?.operation ? "on" : "off";
    const nowIso = toIso(now);
    const electric = nonNegativeNumber(status?.electric);
    const previousState = entry.lastPowerState;
    const stateChanged = previousState !== powerState;
    let shouldSave = stateChanged;

    if (stateChanged) {
      entry.lastPowerState = powerState;
      entry.lastPowerChangedAt = nowIso;
      if (powerState === "on") {
        entry.lastPowerOnAt = nowIso;
        entry.currentSession = {
          startedAt: nowIso,
          source: "poll",
          lastSeenAt: nowIso,
          energyKwh: electric == null ? null : 0,
          counterTracking: true,
          counterBaseline: electric,
          counterResetSeen: electric === 0,
        };
        shouldSave = true;
      } else {
        entry.lastPowerOffAt = nowIso;
        if (entry.currentSession) {
          if (trackSessionEnergy(entry.currentSession, electric)) shouldSave = true;
          const startedAt = parseDate(entry.currentSession.startedAt);
          const durationMs = startedAt ? Math.max(0, now.getTime() - startedAt.getTime()) : 0;
          const energyKwh = nonNegativeNumber(entry.currentSession.energyKwh);
          const averageWatts = energyKwh == null ? null : kwhToWatts(energyKwh, durationMs);

          const session = normalizeSession({
            startedAt: entry.currentSession.startedAt,
            endedAt: nowIso,
            energyKwh,
            averageWatts,
            source: entry.currentSession.source || "poll",
          });
          entry.sessions.push(session);
          entry.completedEnergyKwh += energyKwh ?? 0;
          addSessionToMonthly(entry, session);
        }
        entry.currentSession = null;
        shouldSave = true;
      }
    } else if (powerState === "on") {
      if (!entry.currentSession) {
        entry.currentSession = {
          startedAt: nowIso,
          source: "poll",
          lastSeenAt: nowIso,
          energyKwh: electric == null ? null : 0,
          counterTracking: true,
          counterBaseline: electric,
          counterResetSeen: electric === 0,
        };
        if (!entry.lastPowerOnAt) entry.lastPowerOnAt = nowIso;
        if (!entry.lastPowerChangedAt) entry.lastPowerChangedAt = nowIso;
        shouldSave = true;
      } else {
        entry.currentSession.lastSeenAt = nowIso;
        if (trackSessionEnergy(entry.currentSession, electric)) shouldSave = true;
      }
    } else if (!entry.lastPowerOffAt) {
      entry.lastPowerOffAt = nowIso;
      if (!entry.lastPowerChangedAt) entry.lastPowerChangedAt = nowIso;
      shouldSave = true;
    }

    entry.lastSeenAt = nowIso;
    entry.lastElectricKwh = electric;
    entry.sessions = entry.sessions.slice(-500);

    if (shouldSave) this.save();
    return this.summarize(id, status, now);
  }

  summarize(id, status, now = new Date()) {
    const entry = this.entry(id);
    const currentPower = status?.operation ? "on" : "off";
    const startedAt = entry.currentSession ? parseDate(entry.currentSession.startedAt) : null;
    const currentDurationMs = startedAt ? Math.max(0, now.getTime() - startedAt.getTime()) : 0;
    const currentSessionEnergy = entry.currentSession
      ? nonNegativeNumber(entry.currentSession.energyKwh)
      : null;
    const currentSession = entry.currentSession
      ? {
          startedAt: entry.currentSession.startedAt,
          lastSeenAt: entry.currentSession.lastSeenAt || null,
          energyKwh: currentSessionEnergy,
          durationMs: currentDurationMs,
        }
      : null;

    const lastSessionRaw = entry.sessions[entry.sessions.length - 1] || null;
    const lastSession = lastSessionRaw
      ? {
          ...lastSessionRaw,
          durationMs: Math.max(0, parseDate(lastSessionRaw.endedAt).getTime() - parseDate(lastSessionRaw.startedAt).getTime()),
        }
      : null;

    const monthStart = startOfLocalMonth(now);
    const currentMonthKey = monthKey(now);
    const storedMonthTotal = Number(entry.monthly[currentMonthKey]) || 0;
    const monthTotalKwh = storedMonthTotal
      + (entry.currentSession && currentPower === "on" && currentSessionEnergy != null
        ? energySliceForRange({
            startedAt: entry.currentSession.startedAt,
            endedAt: now.toISOString(),
            energyKwh: currentSessionEnergy,
          }, monthStart, now)
        : 0);

    const dayStart = startOfLocalDay(now);
    const dayTotalKwh = [...entry.sessions].reduce((sum, session) => sum + energySliceForRange(session, dayStart, now), 0)
      + (entry.currentSession && currentPower === "on" && currentSessionEnergy != null
        ? energySliceForRange({
            startedAt: entry.currentSession.startedAt,
            endedAt: now.toISOString(),
            energyKwh: currentSessionEnergy,
          }, dayStart, now)
        : 0);

    const totalKwh = entry.completedEnergyKwh
      + (entry.currentSession && currentPower === "on" ? currentSessionEnergy ?? 0 : 0);
    const currentWatts = currentPower === "on"
      ? nonNegativeNumber(status?.operationData?.powerWatts)
      : 0;

    return {
      powerState: currentPower,
      powerChangedAt: currentPower === "on" ? entry.lastPowerOnAt || entry.lastPowerChangedAt : entry.lastPowerOffAt || entry.lastPowerChangedAt,
      lastPowerOnAt: entry.lastPowerOnAt,
      lastPowerOffAt: entry.lastPowerOffAt,
      lastElectricKwh: entry.lastElectricKwh,
      currentSession,
      lastSession,
      currentWatts,
      dayTotalKwh,
      monthTotalKwh,
      totalKwh,
      monthly: { ...entry.monthly },
      sessions: entry.sessions.slice(-50),
    };
  }
}

module.exports = { HistoryStore };
