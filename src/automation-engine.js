"use strict";

const { ACTION_TYPES, LOGIC_TYPES, temperatureShortcutGraph } = require("./automation-store");
const { applyPresetSettings } = require("./preset-store");
const { MODES } = require("./wfrac");

const DEFAULT_RETRY_MS = 5 * 60 * 1000;
const ACTION_COOLDOWN_MS = 5 * 60 * 1000;

function compare(left, operator, right) {
  if (operator === "gt") return left > right;
  if (operator === "gte") return left >= right;
  if (operator === "lt") return left < right;
  if (operator === "lte") return left <= right;
  return false;
}

function comparatorLabel(operator) {
  return { gt: ">", gte: "≥", lt: "<", lte: "≤" }[operator] || operator;
}

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function parseClock(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function timeCondition(config, now) {
  const start = parseClock(config.start);
  const end = parseClock(config.end);
  const current = minutesSinceMidnight(now);
  let day = now.getDay();
  let inside;

  if (start <= end) {
    inside = current >= start && current < end;
  } else if (current >= start) {
    inside = true;
  } else if (current < end) {
    inside = true;
    day = (day + 6) % 7;
  } else {
    inside = false;
  }

  const value = inside && config.days.includes(day);
  return {
    value,
    message: value
      ? `Current time is inside ${config.start}–${config.end}`
      : `Current time is outside ${config.start}–${config.end}`,
  };
}

function newestIso(values) {
  return values.filter(Boolean).sort().at(-1) || null;
}

function powerStateStartedAt(snapshot, actual) {
  const history = snapshot.history;
  if (!history) return null;
  const value = actual === "on"
    ? history.currentSession?.startedAt || history.powerChangedAt
    : history.powerChangedAt;
  const startedAt = Date.parse(value);
  return Number.isFinite(startedAt) ? startedAt : null;
}

function elapsedLabel(durationMs) {
  const minutes = Math.floor(durationMs / 60000);
  if (minutes < 1) return "less than 1 minute";
  if (minutes === 1) return "1 minute";
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0
    ? `${hours} ${hours === 1 ? "hour" : "hours"}`
    : `${hours}h ${remainder}m`;
}

class AutomationEngine {
  constructor(manager, presetStore, automationStore, {
    intervalMs = 5000,
    retryMs = DEFAULT_RETRY_MS,
    now = () => new Date(),
    logStore = null,
  } = {}) {
    this.manager = manager;
    this.presetStore = presetStore;
    this.store = automationStore;
    this.intervalMs = intervalMs;
    this.retryMs = retryMs;
    this.now = now;
    this.logStore = logStore;
    this.timer = null;
    this.runtime = new Map();
    this.cleanAttempts = new Map();
    this.controlStates = new Map();
    this.evaluation = null;
  }

  start() {
    if (this.timer) return;
    this.evaluateAll().catch((err) => console.warn(`Automation evaluation failed: ${err.message || err}`));
    this.timer = setInterval(() => {
      this.evaluateAll().catch((err) => console.warn(`Automation evaluation failed: ${err.message || err}`));
    }, this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  reset(id) {
    this.runtime.delete(String(id));
  }

  log(entry) {
    if (!this.logStore) return null;
    try {
      return this.logStore.append(entry);
    } catch (err) {
      console.warn(`Automation activity could not be stored: ${err.message || err}`);
      return null;
    }
  }

  listLog(options) {
    return this.logStore ? this.logStore.list(options) : [];
  }

  clearLog() {
    return this.logStore ? this.logStore.clear() : 0;
  }

  list() {
    return this.store.list().map((automation) => ({
      ...automation,
      runtime: this.publicRuntime(automation),
    }));
  }

  get(id) {
    const automation = this.store.get(id);
    return { ...automation, runtime: this.publicRuntime(automation) };
  }

  create(value) {
    const automation = this.store.create(value);
    this.reset(automation.id);
    this.log({
      time: this.now(),
      automationId: automation.id,
      automationName: automation.name,
      event: "flow-created",
      level: "info",
      title: "Flow created",
      message: automation.enabled ? "The flow was created and enabled." : "The flow was created in a disabled state.",
    });
    this.evaluateAll().catch(() => {});
    return { ...automation, runtime: this.publicRuntime(automation) };
  }

  update(id, value) {
    const previous = this.store.get(id);
    const automation = this.store.update(id, value);
    this.reset(id);
    const enabledChanged = previous.enabled !== automation.enabled;
    this.log({
      time: this.now(),
      automationId: automation.id,
      automationName: automation.name,
      event: enabledChanged ? (automation.enabled ? "flow-enabled" : "flow-disabled") : "flow-updated",
      level: "info",
      title: enabledChanged ? (automation.enabled ? "Flow enabled" : "Flow disabled") : "Flow updated",
      message: enabledChanged ? `Automation is now ${automation.enabled ? "enabled" : "disabled"}.` : "The flow configuration was saved.",
    });
    this.evaluateAll().catch(() => {});
    return { ...automation, runtime: this.publicRuntime(automation) };
  }

  remove(id) {
    const removed = this.store.remove(id);
    this.reset(id);
    this.log({
      time: this.now(),
      automationId: removed.id,
      automationName: removed.name,
      event: "flow-deleted",
      level: "warning",
      title: "Flow deleted",
      message: "The automation was removed.",
    });
    return removed;
  }

  createTemperatureShortcut(value) {
    const aircoId = String(value.aircoId || "");
    const presetId = String(value.presetId || "");
    this.manager.get(aircoId);
    const preset = this.presetStore.get(aircoId, presetId);
    const graph = temperatureShortcutGraph({ ...value, stopMode: preset.settings.mode });
    return this.create({
      name: value.name || "Temperature control",
      enabled: value.enabled === undefined ? true : Boolean(value.enabled),
      ...graph,
    });
  }

  runtimeEntry(automation) {
    let entry = this.runtime.get(automation.id);
    if (!entry) {
      entry = {
        status: automation.enabled ? "waiting" : "disabled",
        message: automation.enabled ? "Waiting for the first evaluation" : "Automation is disabled",
        lastEvaluatedAt: null,
        actionStates: new Map(),
        nodeStates: new Map(),
      };
      this.runtime.set(automation.id, entry);
    }
    return entry;
  }

  publicRuntime(automation) {
    const entry = this.runtimeEntry(automation);
    const actionStates = Object.fromEntries([...entry.actionStates].map(([id, state]) => [id, {
      result: state.result ?? null,
      message: state.message || null,
      lastEvaluatedAt: state.lastEvaluatedAt || null,
      lastTriggeredAt: state.lastTriggeredAt || null,
      lastError: state.lastError || null,
      manualOverride: state.manualOverride || null,
    }]));
    const states = [...entry.actionStates.values()];
    const nodeStates = Object.fromEntries([...entry.nodeStates].map(([id, state]) => [id, {
      result: state.value ?? null,
      message: state.message || null,
      actual: state.actual ?? null,
    }]));
    return {
      status: entry.status,
      message: entry.message,
      lastEvaluatedAt: entry.lastEvaluatedAt,
      lastTriggeredAt: newestIso(states.map((state) => state.lastTriggeredAt)),
      lastError: states.map((state) => state.lastError).filter(Boolean).at(-1) || null,
      actionStates,
      nodeStates,
    };
  }

  async evaluateAll() {
    if (this.evaluation) return this.evaluation;
    this.evaluation = (async () => {
      this.processManualOverrides();
      this.detectExternalControlChanges();
      await this.processPendingCleans(this.now());
      for (const automation of this.store.list()) {
        await this.evaluateAutomation(automation);
      }
    })();
    try {
      await this.evaluation;
    } finally {
      this.evaluation = null;
    }
  }

  manualOverride(aircoId) {
    return this.store.getManualOverride(aircoId);
  }

  controlState(aircoId) {
    try {
      const snapshot = this.manager.get(aircoId).snapshot();
      if (!snapshot?.status || snapshot.online === false) return null;
      const status = snapshot.status;
      return {
        signature: JSON.stringify({
          power: status.power || (status.operation ? "on" : "off"),
          mode: status.operationModeName ?? status.operationMode ?? null,
          temperature: status.presetTemp ?? null,
          airflow: status.airFlowName ?? status.airFlow ?? null,
          windDirectionUD: status.windDirectionUD ?? null,
          windDirectionLR: status.windDirectionLR ?? null,
          entrust: Boolean(status.entrust),
          vacant: Boolean(status.isVacantProperty),
        }),
        isOn: status.power === "on" || status.operation === true,
      };
    } catch {
      return null;
    }
  }

  acknowledgeControlState(aircoId) {
    const state = this.controlState(aircoId);
    if (state) this.controlStates.set(String(aircoId), state.signature);
  }

  detectExternalControlChanges() {
    const aircoIds = new Set();
    if (typeof this.manager.configs === "function") {
      for (const config of this.manager.configs()) aircoIds.add(String(config.id));
    } else {
      for (const automation of this.store.list()) {
        for (const node of automation.nodes) {
          if (ACTION_TYPES.has(node.type) && node.config.aircoId) aircoIds.add(String(node.config.aircoId));
        }
      }
    }
    for (const override of this.store.listManualOverrides()) aircoIds.add(override.aircoId);

    for (const aircoId of aircoIds) {
      const state = this.controlState(aircoId);
      if (!state) continue;
      const previous = this.controlStates.get(aircoId);
      this.controlStates.set(aircoId, state.signature);
      if (previous === undefined || previous === state.signature || !state.isOn) continue;
      if (!this.store.getManualOverride(aircoId)) {
        this.activateManualOverride(aircoId, { source: "remote-control" });
      }
    }
  }

  activateManualOverride(aircoId, { source = "manual-control" } = {}) {
    const runtime = this.manager.get(aircoId);
    const existing = this.store.getManualOverride(aircoId);
    const entry = existing || this.store.setManualOverride({
      aircoId,
      source,
      startedAt: this.now(),
    });
    const pendingClean = this.store.removePendingClean(aircoId);
    this.cleanAttempts.delete(String(aircoId));
    runtime.setManagedSelfClean?.(null);
    if (pendingClean) {
      this.logCleanActivity(pendingClean, this.now(), {
        event: "clean-cancelled",
        level: "info",
        title: "Clean cycle cancelled",
        message: "Manual control took over the air conditioner.",
      });
    }
    if (!existing) {
      this.log({
        time: this.now(),
        automationId: "",
        automationName: "Manual control",
        event: "manual-override-started",
        level: "info",
        title: "Manual control started",
        message: `Automation actions for ${aircoId} are paused until it is switched off or manually resumed.`,
        action: { type: "manual-override", aircoId, active: true, source },
      });
    }
    this.acknowledgeControlState(aircoId);
    return entry;
  }

  clearManualOverride(aircoId, { reason = "Automation control was manually resumed." } = {}) {
    const removed = this.store.removeManualOverride(aircoId);
    if (!removed) return null;
    this.log({
      time: this.now(),
      automationId: "",
      automationName: "Manual control",
      event: "manual-override-ended",
      level: "info",
      title: "Automation control resumed",
      message: reason,
      action: { type: "manual-override", aircoId: String(aircoId), active: false },
    });
    return removed;
  }

  processManualOverrides() {
    for (const override of this.store.listManualOverrides()) {
      let snapshot;
      try {
        snapshot = this.manager.get(override.aircoId).snapshot();
      } catch (err) {
        this.clearManualOverride(override.aircoId, { reason: err.message || String(err) });
        continue;
      }
      if (!snapshot?.status || snapshot.online === false) continue;
      const isOn = snapshot.status.power === "on" || snapshot.status.operation === true;
      if (!isOn) {
        this.clearManualOverride(override.aircoId, {
          reason: "The air conditioner was switched off; automation control resumed automatically.",
        });
      }
    }
  }

  aircoSnapshot(aircoId) {
    try {
      const snapshot = this.manager.get(aircoId).snapshot();
      if (!snapshot?.status) return { error: "No status available" };
      if (snapshot.online === false) return { error: "Air conditioner is offline" };
      return { snapshot };
    } catch (err) {
      return { error: err.message || String(err) };
    }
  }

  evaluateCondition(node, now) {
    if (node.type === "time") return timeCondition(node.config, now);

    const { snapshot, error } = this.aircoSnapshot(node.config.aircoId);
    if (error) return { value: null, message: error };

    if (node.type === "temperature") {
      const field = node.config.sensor === "indoor" ? "indoorTemp" : "outdoorTemp";
      const actual = Number(snapshot.status[field]);
      if (!Number.isFinite(actual)) return { value: null, message: `${node.config.sensor} temperature is unavailable` };
      const value = compare(actual, node.config.operator, node.config.value);
      return {
        value,
        message: `${node.config.sensor === "indoor" ? "Indoor" : "Outdoor"} ${actual} °C ${comparatorLabel(node.config.operator)} ${node.config.value} °C is ${value ? "true" : "false"}`,
        actual,
      };
    }

    if (node.type === "power") {
      const actual = snapshot.status.power || (snapshot.status.operation ? "on" : "off");
      const matchesState = actual === node.config.state;
      const durationMinutes = node.config.durationMinutes ?? 0;
      if (!matchesState || durationMinutes === 0) {
        return {
          value: matchesState,
          message: `Power is ${actual}; expected ${node.config.state}`,
          actual,
        };
      }

      const startedAt = powerStateStartedAt(snapshot, actual);
      if (startedAt == null) {
        return {
          value: null,
          message: `Power is ${actual}, but its start time is unavailable`,
          actual,
        };
      }
      const elapsedMs = Math.max(0, now.getTime() - startedAt);
      const requiredMs = durationMinutes * 60 * 1000;
      const value = elapsedMs >= requiredMs;
      return {
        value,
        message: `Power has been ${actual} for ${elapsedLabel(elapsedMs)}; requires at least ${durationMinutes} minutes`,
        actual,
      };
    }

    if (node.type === "mode") {
      const actual = snapshot.status.operationModeName;
      if (!actual) return { value: null, message: "Operation mode is unavailable" };
      const value = actual === node.config.mode;
      return { value, message: `Mode is ${actual}; expected ${node.config.mode}`, actual };
    }

    return { value: null, message: `Unsupported condition ${node.type}` };
  }

  evaluateInput(nodeId, graph, now, cache) {
    if (cache.has(nodeId)) return cache.get(nodeId);
    const node = graph.nodeById.get(nodeId);
    if (!node) return { value: null, message: "Missing block" };

    if (!LOGIC_TYPES.has(node.type)) {
      const result = this.evaluateCondition(node, now);
      cache.set(nodeId, result);
      return result;
    }

    const inputs = graph.incoming.get(nodeId) || [];
    if (inputs.length < 2) {
      const result = { value: null, message: `${node.type.toUpperCase()} needs at least two inputs` };
      cache.set(nodeId, result);
      return result;
    }
    const results = inputs.map((id) => this.evaluateInput(id, graph, now, cache));
    let value;
    if (node.type === "and") {
      value = results.some((result) => result.value === false)
        ? false
        : results.some((result) => result.value == null) ? null : true;
    } else {
      value = results.some((result) => result.value === true)
        ? true
        : results.some((result) => result.value == null) ? null : false;
    }
    const result = {
      value,
      message: `${node.type.toUpperCase()}: ${value == null ? "waiting for input" : value ? "conditions match" : "conditions do not match"}`,
    };
    cache.set(nodeId, result);
    return result;
  }

  conditionDetails(actionId, graph, cache) {
    const details = [];
    const seen = new Set();
    const collect = (nodeId) => {
      if (seen.has(nodeId)) return;
      seen.add(nodeId);
      const node = graph.nodeById.get(nodeId);
      if (!node) return;
      if (LOGIC_TYPES.has(node.type)) {
        for (const input of graph.incoming.get(nodeId) || []) collect(input);
        return;
      }
      const state = cache.get(nodeId);
      details.push({
        nodeId,
        type: node.type,
        result: state?.value ?? null,
        message: state?.message || "Not evaluated",
        actual: state?.actual ?? null,
      });
    };
    for (const input of graph.incoming.get(actionId) || []) collect(input);
    return details;
  }

  async processPendingCleans(now) {
    for (const pending of this.store.listPendingCleans()) {
      let runtime;
      try {
        runtime = this.manager.get(pending.aircoId);
      } catch (err) {
        this.store.removePendingClean(pending.aircoId);
        this.cleanAttempts.delete(pending.aircoId);
        this.logCleanActivity(pending, now, {
          event: "clean-cancelled",
          level: "warning",
          title: "Clean cycle cancelled",
          message: err.message || String(err),
        });
        continue;
      }

      runtime.setManagedSelfClean?.(pending);

      const snapshot = runtime.snapshot();
      if (!snapshot?.status || snapshot.online === false) continue;
      const isOn = snapshot.status.power === "on" || snapshot.status.operation === true;
      const mode = snapshot.status.operationModeName || snapshot.status.mode;
      if (!isOn || mode !== "fan") {
        this.store.removePendingClean(pending.aircoId);
        this.cleanAttempts.delete(pending.aircoId);
        runtime.setManagedSelfClean?.(null);
        this.logCleanActivity(pending, now, {
          event: "clean-cancelled",
          level: "info",
          title: "Clean cycle ended early",
          message: isOn
            ? "Another mode took over, so the scheduled shutdown was cancelled."
            : "The air conditioner was already off.",
        });
        continue;
      }

      if (now.getTime() < Date.parse(pending.endsAt)) continue;
      const lastAttempt = this.cleanAttempts.get(pending.aircoId) || 0;
      if (now.getTime() - lastAttempt < this.retryMs) continue;
      this.cleanAttempts.set(pending.aircoId, now.getTime());

      try {
        let switchedOff = false;
        await runtime.update((status) => {
          if (status.operation && status.operationMode === MODES.fan) {
            status.setPower(false);
            switchedOff = true;
          }
        });
        this.store.removePendingClean(pending.aircoId);
        this.acknowledgeControlState(pending.aircoId);
        this.cleanAttempts.delete(pending.aircoId);
        runtime.setManagedSelfClean?.(null);
        this.logCleanActivity(pending, now, switchedOff ? {
          event: "clean-completed",
          level: "info",
          title: "Clean cycle completed",
          message: `Fan ran for ${pending.durationMinutes} minutes; the air conditioner is now off.`,
        } : {
          event: "clean-cancelled",
          level: "info",
          title: "Clean cycle ended early",
          message: "Another mode took over, so the scheduled shutdown was cancelled.",
        });
      } catch (err) {
        this.logCleanActivity(pending, now, {
          event: "clean-failed",
          level: "error",
          title: "Clean shutdown failed",
          message: `${err.message || String(err)}; another attempt will follow.`,
        });
      }
    }
  }

  logCleanActivity(pending, time, details) {
    this.log({
      time,
      automationId: pending.automationId,
      automationName: pending.automationName,
      actionNodeId: pending.actionNodeId,
      ...details,
      action: {
        type: "set-power",
        aircoId: pending.aircoId,
        state: "clean",
        durationMinutes: pending.durationMinutes,
      },
    });
  }

  async runAction(node, automation) {
    const runtime = this.manager.get(node.config.aircoId);
    if (node.type === "apply-preset") {
      const preset = this.presetStore.get(runtime.config.id, node.config.presetId);
      await runtime.update((status) => applyPresetSettings(status, preset.settings));
      this.store.removePendingClean(runtime.config.id);
      this.cleanAttempts.delete(runtime.config.id);
      runtime.setManagedSelfClean?.(null);
      runtime.vacantPresetRestoreState = null;
      return {
        message: `Applied preset ${preset.name}`,
        title: `Preset “${preset.name}” started`,
        action: {
          type: node.type,
          aircoId: runtime.config.id,
          presetId: preset.id,
          presetName: preset.name,
        },
      };
    }
    if (node.type === "set-power") {
      if (node.config.state === "clean") {
        const durationMinutes = node.config.durationMinutes ?? 30;
        const pendingClean = this.store.listPendingCleans()
          .find((pending) => pending.aircoId === runtime.config.id);
        if (pendingClean) {
          runtime.setManagedSelfClean?.(pendingClean);
          return {
            event: "action-skipped",
            message: `Clean cycle already in progress until ${pendingClean.endsAt}; original end time preserved`,
            title: "Clean cycle already in progress",
            action: {
              type: node.type,
              aircoId: runtime.config.id,
              state: node.config.state,
              durationMinutes: pendingClean.durationMinutes,
              endsAt: pendingClean.endsAt,
              alreadyActive: true,
            },
          };
        }
        const startedAt = this.now();
        const endsAt = new Date(startedAt.getTime() + durationMinutes * 60 * 1000);
        let skippedMode = null;
        await runtime.update((status) => {
          if (status.operationMode === MODES.heat || status.operationMode === MODES.fan) {
            skippedMode = status.operationMode === MODES.heat ? "Heat" : "Fan";
            status.setPower(false);
            return;
          }
          status.setMode("fan");
          status.setAirFlow("low");
          status.setPower(true);
        });
        if (skippedMode) {
          this.store.removePendingClean(runtime.config.id);
          this.cleanAttempts.delete(runtime.config.id);
          runtime.setManagedSelfClean?.(null);
          return {
            message: `Clean cycle skipped after ${skippedMode}; power turned off`,
            title: `Clean cycle skipped after ${skippedMode}`,
            action: {
              type: node.type,
              aircoId: runtime.config.id,
              state: node.config.state,
              durationMinutes,
              skipped: true,
              previousMode: skippedMode.toLowerCase(),
            },
          };
        }
        try {
          this.store.setPendingClean({
            aircoId: runtime.config.id,
            automationId: automation.id,
            automationName: automation.name,
            actionNodeId: node.id,
            durationMinutes,
            startedAt,
            endsAt,
          });
        } catch (err) {
          await runtime.update((status) => status.setPower(false)).catch(() => {});
          throw err;
        }
        this.cleanAttempts.delete(runtime.config.id);
        runtime.setManagedSelfClean?.(this.store.listPendingCleans()
          .find((pending) => pending.aircoId === runtime.config.id) || null);
        return {
          message: `Fan cleaning for ${durationMinutes} minutes, then power off`,
          title: `Clean cycle started for ${durationMinutes} minutes`,
          action: {
            type: node.type,
            aircoId: runtime.config.id,
            state: node.config.state,
            durationMinutes,
            endsAt: endsAt.toISOString(),
          },
        };
      }
      await runtime.update((status) => status.setPower(node.config.state === "on"));
      this.store.removePendingClean(runtime.config.id);
      this.cleanAttempts.delete(runtime.config.id);
      runtime.setManagedSelfClean?.(null);
      return {
        message: `Turned power ${node.config.state}`,
        title: `Air conditioner switched ${node.config.state}`,
        action: { type: node.type, aircoId: runtime.config.id, state: node.config.state },
      };
    }
    throw new Error(`Unsupported action ${node.type}`);
  }

  async evaluateAutomation(automation) {
    const runtime = this.runtimeEntry(automation);
    const now = this.now();
    const nowIso = now.toISOString();
    runtime.lastEvaluatedAt = nowIso;

    const graph = {
      nodeById: new Map(automation.nodes.map((node) => [node.id, node])),
      incoming: new Map(automation.nodes.map((node) => [node.id, []])),
    };
    for (const edge of automation.edges) graph.incoming.get(edge.to)?.push(edge.from);
    const actions = automation.nodes.filter((node) => ACTION_TYPES.has(node.type));
    if (actions.length === 0) {
      runtime.status = automation.enabled ? "invalid" : "disabled";
      runtime.message = automation.enabled
        ? "Add an action block to complete this automation"
        : "Automation is disabled; no action blocks to preview";
      return;
    }

    const cache = new Map();
    for (const action of actions) {
      let state = runtime.actionStates.get(action.id);
      if (!state) {
        state = {
          latched: false,
          cooldownLogged: false,
          result: null,
          lastAttemptAt: null,
          lastTriggeredAt: null,
          lastError: null,
          manualOverride: null,
          manualOverrideLogged: false,
        };
        runtime.actionStates.set(action.id, state);
      }
      const inputs = graph.incoming.get(action.id) || [];
      const result = inputs.length === 1
        ? this.evaluateInput(inputs[0], graph, now, cache)
        : { value: null, message: "Action needs exactly one input" };
      state.result = result.value;
      state.message = result.message;
      state.lastEvaluatedAt = nowIso;
      state.manualOverride = null;

      if (!automation.enabled) {
        state.latched = false;
        state.cooldownLogged = false;
        state.manualOverrideLogged = false;
        continue;
      }

      if (result.value === false) {
        state.latched = false;
        state.cooldownLogged = false;
        state.manualOverrideLogged = false;
        continue;
      }
      if (result.value == null) continue;

      const manualOverride = this.store.getManualOverride(action.config.aircoId);
      if (manualOverride) {
        state.manualOverride = manualOverride;
        state.latched = false;
        state.cooldownLogged = false;
        state.message = "Conditions match, but manual control is active";
        if (!state.manualOverrideLogged) {
          this.log({
            time: now,
            automationId: automation.id,
            automationName: automation.name,
            actionNodeId: action.id,
            event: "action-manual-override",
            level: "info",
            title: "Action paused by manual control",
            message: `Automation actions for ${action.config.aircoId} are temporarily paused.`,
            action: { type: action.type, ...action.config },
            conditions: this.conditionDetails(action.id, graph, cache),
          });
          state.manualOverrideLogged = true;
        }
        continue;
      }
      state.manualOverrideLogged = false;
      if (state.latched) continue;

      const lastTriggerMs = state.lastTriggeredAt ? Date.parse(state.lastTriggeredAt) : 0;
      const cooldownMs = ACTION_COOLDOWN_MS;
      if (lastTriggerMs && now.getTime() - lastTriggerMs < cooldownMs) {
        state.message = "Conditions match, but the cooldown is still active";
        if (!state.cooldownLogged) {
          const remainingSeconds = Math.ceil((cooldownMs - (now.getTime() - lastTriggerMs)) / 1000);
          this.log({
            time: now,
            automationId: automation.id,
            automationName: automation.name,
            actionNodeId: action.id,
            event: "action-cooldown",
            level: "warning",
            title: "Action skipped during cooldown",
            message: `${remainingSeconds} seconds of cooldown remaining.`,
            action: { type: action.type, ...action.config },
            conditions: this.conditionDetails(action.id, graph, cache),
          });
          state.cooldownLogged = true;
        }
        continue;
      }
      const lastAttemptMs = state.lastAttemptAt ? Date.parse(state.lastAttemptAt) : 0;
      if (lastAttemptMs && now.getTime() - lastAttemptMs < this.retryMs) continue;

      state.lastAttemptAt = nowIso;
      try {
        const outcome = await this.runAction(action, automation);
        this.acknowledgeControlState(action.config.aircoId);
        state.message = outcome.message;
        state.lastTriggeredAt = nowIso;
        state.lastError = null;
        state.latched = true;
        state.cooldownLogged = false;
        this.log({
          time: now,
          automationId: automation.id,
          automationName: automation.name,
          actionNodeId: action.id,
          event: outcome.event || "action-executed",
          level: "info",
          title: outcome.title,
          message: outcome.message,
          action: outcome.action,
          conditions: this.conditionDetails(action.id, graph, cache),
        });
      } catch (err) {
        state.lastError = { message: err.message || String(err), time: nowIso };
        state.message = `Action failed: ${state.lastError.message}`;
        this.log({
          time: now,
          automationId: automation.id,
          automationName: automation.name,
          actionNodeId: action.id,
          event: "action-failed",
          level: "error",
          title: "Automation action failed",
          message: state.lastError.message,
          action: { type: action.type, ...action.config },
          conditions: this.conditionDetails(action.id, graph, cache),
        });
      }
    }

    runtime.nodeStates = new Map(cache);

    if (!automation.enabled) {
      runtime.status = "disabled";
      runtime.message = "Automation is disabled; conditions are still being monitored";
      return;
    }

    const states = actions.map((action) => runtime.actionStates.get(action.id));
    if (states.some((state) => state.lastError && state.result === true)) {
      runtime.status = "error";
      runtime.message = states.find((state) => state.lastError && state.result === true).message;
    } else if (states.some((state) => state.result === true && !state.manualOverride)) {
      runtime.status = "active";
      runtime.message = "One or more action paths are active";
    } else if (states.some((state) => state.result === true && state.manualOverride)) {
      runtime.status = "overridden";
      runtime.message = "Matching actions are paused by manual control";
    } else if (states.some((state) => state.result == null)) {
      runtime.status = "waiting";
      runtime.message = states.find((state) => state.result == null).message;
    } else {
      runtime.status = "idle";
      runtime.message = "Conditions do not currently match";
    }
  }
}

module.exports = { AutomationEngine, compare, timeCondition };
