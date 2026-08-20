"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_AUTOMATIONS = 100;
const MAX_NODES = 40;
const MAX_EDGES = 80;
const CONDITION_TYPES = new Set(["temperature", "power", "mode", "time"]);
const LOGIC_TYPES = new Set(["and", "or"]);
const ACTION_TYPES = new Set(["apply-preset", "set-power"]);
const NODE_TYPES = new Set([...CONDITION_TYPES, ...LOGIC_TYPES, ...ACTION_TYPES]);

function httpError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function text(value, field, maxLength = 100) {
  const normalized = String(value || "").trim();
  if (!normalized) throw httpError(`${field} is required`);
  if (normalized.length > maxLength) throw httpError(`${field} is too long`);
  return normalized;
}

function numberInRange(value, min, max, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw httpError(`Invalid ${field}`);
  }
  return number;
}

function normalizePosition(value) {
  const x = numberInRange(value?.x ?? 0, -10000, 10000, "node x position");
  const y = numberInRange(value?.y ?? 0, -10000, 10000, "node y position");
  return { x: Math.round(x), y: Math.round(y) };
}

function normalizeTime(value, field) {
  const normalized = String(value || "");
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(normalized)) throw httpError(`Invalid ${field}`);
  return normalized;
}

function normalizeConfig(type, value) {
  const config = value && typeof value === "object" ? value : {};
  if (type === "temperature") {
    const operator = String(config.operator || "gt");
    if (!["gt", "gte", "lt", "lte"].includes(operator)) throw httpError("Invalid temperature operator");
    const sensor = String(config.sensor || "indoor");
    if (!["indoor", "outdoor"].includes(sensor)) throw httpError("Invalid temperature sensor");
    return {
      aircoId: text(config.aircoId, "temperature aircoId"),
      sensor,
      operator,
      value: numberInRange(config.value, -40, 60, "temperature value"),
    };
  }
  if (type === "power") {
    const state = String(config.state || "off");
    if (!["on", "off"].includes(state)) throw httpError("Invalid power state");
    return {
      aircoId: text(config.aircoId, "power aircoId"),
      state,
      durationMinutes: Math.round(numberInRange(
        config.durationMinutes ?? 0,
        0,
        10080,
        "power duration"
      )),
    };
  }
  if (type === "mode") {
    const mode = String(config.mode || "cool").toLowerCase();
    if (!["auto", "cool", "heat", "fan", "dry"].includes(mode)) throw httpError("Invalid operation mode");
    return { aircoId: text(config.aircoId, "mode aircoId"), mode };
  }
  if (type === "time") {
    const days = Array.isArray(config.days) ? [...new Set(config.days.map(Number))] : [0, 1, 2, 3, 4, 5, 6];
    if (days.length === 0 || days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
      throw httpError("Invalid time days");
    }
    return {
      start: normalizeTime(config.start || "08:00", "start time"),
      end: normalizeTime(config.end || "22:00", "end time"),
      days: days.sort(),
    };
  }
  if (type === "apply-preset") {
    return {
      aircoId: text(config.aircoId, "preset aircoId"),
      presetId: text(config.presetId, "presetId"),
    };
  }
  if (type === "set-power") {
    const state = String(config.state || "off");
    if (!["on", "off", "clean"].includes(state)) throw httpError("Invalid action power state");
    const normalized = { aircoId: text(config.aircoId, "action aircoId"), state };
    if (state === "clean") {
      normalized.durationMinutes = Math.round(numberInRange(
        config.durationMinutes ?? 30,
        1,
        180,
        "clean duration"
      ));
    }
    return normalized;
  }
  return {};
}

function normalizeNode(value) {
  if (!value || typeof value !== "object") throw httpError("Invalid automation node");
  const type = String(value.type || "");
  if (!NODE_TYPES.has(type)) throw httpError(`Unknown automation node type: ${type || "empty"}`);
  return {
    id: text(value.id, "node id", 100),
    type,
    position: normalizePosition(value.position),
    config: normalizeConfig(type, value.config),
  };
}

function normalizeEdge(value) {
  if (!value || typeof value !== "object") throw httpError("Invalid automation connection");
  return {
    id: text(value.id, "connection id", 100),
    from: text(value.from, "connection source", 100),
    to: text(value.to, "connection target", 100),
  };
}

function validateGraph(nodes, edges) {
  if (nodes.length > MAX_NODES) throw httpError(`An automation can contain at most ${MAX_NODES} blocks`);
  if (edges.length > MAX_EDGES) throw httpError(`An automation can contain at most ${MAX_EDGES} connections`);

  const nodeById = new Map();
  for (const node of nodes) {
    if (nodeById.has(node.id)) throw httpError(`Duplicate node id: ${node.id}`);
    nodeById.set(node.id, node);
  }

  const edgeIds = new Set();
  const pairs = new Set();
  const incoming = new Map(nodes.map((node) => [node.id, []]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) throw httpError(`Duplicate connection id: ${edge.id}`);
    edgeIds.add(edge.id);
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to) throw httpError("A connection refers to a missing block");
    if (from.id === to.id) throw httpError("A block cannot connect to itself");
    if (ACTION_TYPES.has(from.type)) throw httpError("An action block cannot have an output");
    if (CONDITION_TYPES.has(to.type)) throw httpError("A condition block cannot have an input");
    const pair = `${from.id}\u0000${to.id}`;
    if (pairs.has(pair)) throw httpError("Duplicate connection");
    pairs.add(pair);
    incoming.get(to.id).push(from.id);
    outgoing.get(from.id).push(to.id);
  }

  for (const node of nodes) {
    if (ACTION_TYPES.has(node.type) && incoming.get(node.id).length > 1) {
      throw httpError("An action block accepts one input; use an AND or OR block to combine conditions");
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw httpError("Automation connections cannot contain a loop");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of outgoing.get(id)) visit(next);
    visiting.delete(id);
    visited.add(id);
  }
  for (const node of nodes) visit(node.id);
}

function normalizeAutomation(value, { id, createdAt, now = new Date() } = {}) {
  if (!value || typeof value !== "object") throw httpError("Invalid automation");
  const nodes = Array.isArray(value.nodes) ? value.nodes.map(normalizeNode) : [];
  const edges = Array.isArray(value.edges) ? value.edges.map(normalizeEdge) : [];
  validateGraph(nodes, edges);
  return {
    id: id || text(value.id, "automation id", 100),
    name: text(value.name, "automation name", 60),
    enabled: value.enabled === undefined ? true : Boolean(value.enabled),
    nodes,
    edges,
    createdAt: new Date(createdAt || value.createdAt || now).toISOString(),
    updatedAt: now.toISOString(),
  };
}

function graphId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function temperatureShortcutGraph({
  aircoId,
  presetId,
  startTemperature,
  stopStrategy,
  stopTemperature,
  stopMode = "cool",
  outdoorHysteresis = 1.5,
}) {
  const unitId = text(aircoId, "aircoId");
  const preset = text(presetId, "presetId");
  const start = numberInRange(startTemperature, -40, 60, "start temperature");
  const strategy = String(stopStrategy || "outdoor");
  if (!["outdoor", "indoor", "none"].includes(strategy)) throw httpError("Invalid stop strategy");
  const stop = strategy === "none" ? null : numberInRange(stopTemperature, -40, 60, "stop temperature");
  const hysteresis = strategy === "outdoor"
    ? numberInRange(outdoorHysteresis, 0.5, 10, "outdoor hysteresis")
    : null;
  if (strategy === "indoor" && stop >= start) {
    throw httpError("The indoor switch-off temperature must be lower than the switch-on temperature");
  }

  const nodes = [];
  const edges = [];
  const addNode = (type, x, y, config = {}) => {
    const node = { id: graphId(type), type, position: { x, y }, config };
    nodes.push(node);
    return node;
  };
  const connect = (from, to) => edges.push({ id: graphId("edge"), from: from.id, to: to.id });

  // Temperature cards contain one more row than power and logic cards. Keep the
  // conditions in columns so their dynamic heights never overlap in the initial flow.
  const indoorHot = addNode("temperature", 70, 70, {
    aircoId: unitId, sensor: "indoor", operator: "gt", value: start,
  });
  const currentlyOff = addNode("power", strategy === "outdoor" ? 70 : 350, strategy === "outdoor" ? 340 : 70, {
    aircoId: unitId, state: "off",
  });
  const startAnd = addNode("and", 650, 200);
  const applyPreset = addNode("apply-preset", 920, 185, { aircoId: unitId, presetId: preset });
  connect(indoorHot, startAnd);
  connect(currentlyOff, startAnd);

  if (strategy === "outdoor") {
    const outdoorWarm = addNode("temperature", 350, 70, {
      aircoId: unitId, sensor: "outdoor", operator: "gte", value: stop + hysteresis,
    });
    connect(outdoorWarm, startAnd);
  }
  connect(startAnd, applyPreset);

  if (strategy !== "none") {
    const stopTemperatureNode = addNode("temperature", 70, 650, {
      aircoId: unitId,
      sensor: strategy,
      operator: "lt",
      value: stop,
    });
    const currentlyOn = addNode("power", 350, 650, {
      aircoId: unitId, state: "on", durationMinutes: 30,
    });
    const matchingMode = addNode("mode", 350, 900, { aircoId: unitId, mode: stopMode });
    const stopAnd = addNode("and", 650, 720);
    const powerOff = addNode("set-power", 920, 700, {
      aircoId: unitId, state: "clean", durationMinutes: 30,
    });
    connect(stopTemperatureNode, stopAnd);
    connect(currentlyOn, stopAnd);
    connect(matchingMode, stopAnd);
    connect(stopAnd, powerOff);
  }

  return { nodes, edges };
}

function normalizePendingClean(value) {
  if (!value || typeof value !== "object") throw new Error("Invalid pending clean cycle");
  const startedAt = new Date(value.startedAt);
  const endsAt = new Date(value.endsAt);
  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startedAt) {
    throw new Error("Invalid pending clean cycle time");
  }
  return {
    aircoId: text(value.aircoId, "clean aircoId"),
    automationId: text(value.automationId, "clean automationId"),
    automationName: text(value.automationName || "Automation", "clean automationName", 60),
    actionNodeId: text(value.actionNodeId, "clean actionNodeId"),
    durationMinutes: Math.round(numberInRange(value.durationMinutes ?? 30, 1, 180, "clean duration")),
    startedAt: startedAt.toISOString(),
    endsAt: endsAt.toISOString(),
  };
}

function normalizeManualOverride(value) {
  if (!value || typeof value !== "object") throw new Error("Invalid manual override");
  const startedAt = new Date(value.startedAt);
  if (Number.isNaN(startedAt.getTime())) throw new Error("Invalid manual override time");
  return {
    aircoId: text(value.aircoId, "manual override aircoId"),
    startedAt: startedAt.toISOString(),
    source: text(value.source || "manual-control", "manual override source", 60),
  };
}

class AutomationStore {
  constructor(filePath = "data/airco-automations.json") {
    this.filePath = filePath;
    this.state = this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return { version: 3, automations: [], pendingCleans: [], manualOverrides: [] };
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.automations)) {
        throw new Error("Invalid automation file");
      }
      const automations = parsed.automations.flatMap((automation) => {
        try {
          return [normalizeAutomation(automation, {
            id: String(automation.id),
            createdAt: automation.createdAt,
            now: new Date(automation.updatedAt || automation.createdAt || Date.now()),
          })];
        } catch {
          return [];
        }
      });
      const pendingCleans = (Array.isArray(parsed.pendingCleans) ? parsed.pendingCleans : []).flatMap((entry) => {
        try {
          return [normalizePendingClean(entry)];
        } catch {
          return [];
        }
      });
      const manualOverrides = (Array.isArray(parsed.manualOverrides) ? parsed.manualOverrides : []).flatMap((entry) => {
        try {
          return [normalizeManualOverride(entry)];
        } catch {
          return [];
        }
      });
      return { version: 3, automations, pendingCleans, manualOverrides };
    } catch {
      return { version: 3, automations: [], pendingCleans: [], manualOverrides: [] };
    }
  }

  save() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryFile = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryFile, `${JSON.stringify(this.state, null, 2)}\n`);
    fs.renameSync(temporaryFile, this.filePath);
  }

  list() {
    return structuredClone(this.state.automations);
  }

  get(id) {
    const automation = this.state.automations.find((candidate) => candidate.id === String(id));
    if (!automation) throw httpError("Unknown automation", 404);
    return structuredClone(automation);
  }

  create(value, now = new Date()) {
    if (this.state.automations.length >= MAX_AUTOMATIONS) {
      throw httpError(`At most ${MAX_AUTOMATIONS} automations can be stored`, 409);
    }
    const automation = normalizeAutomation(value, { id: crypto.randomUUID(), now });
    this.state.automations.push(automation);
    this.save();
    return structuredClone(automation);
  }

  update(id, value, now = new Date()) {
    const index = this.state.automations.findIndex((candidate) => candidate.id === String(id));
    if (index < 0) throw httpError("Unknown automation", 404);
    const current = this.state.automations[index];
    const automation = normalizeAutomation({ ...current, ...value }, {
      id: current.id,
      createdAt: current.createdAt,
      now,
    });
    this.state.automations[index] = automation;
    this.save();
    return structuredClone(automation);
  }

  remove(id) {
    const index = this.state.automations.findIndex((candidate) => candidate.id === String(id));
    if (index < 0) throw httpError("Unknown automation", 404);
    const [removed] = this.state.automations.splice(index, 1);
    this.save();
    return structuredClone(removed);
  }

  listPendingCleans() {
    return structuredClone(this.state.pendingCleans);
  }

  setPendingClean(value) {
    const entry = normalizePendingClean(value);
    this.state.pendingCleans = this.state.pendingCleans.filter((candidate) => candidate.aircoId !== entry.aircoId);
    this.state.pendingCleans.push(entry);
    this.save();
    return structuredClone(entry);
  }

  removePendingClean(aircoId) {
    const index = this.state.pendingCleans.findIndex((candidate) => candidate.aircoId === String(aircoId));
    if (index < 0) return null;
    const [removed] = this.state.pendingCleans.splice(index, 1);
    this.save();
    return structuredClone(removed);
  }

  listManualOverrides() {
    return structuredClone(this.state.manualOverrides);
  }

  getManualOverride(aircoId) {
    const entry = this.state.manualOverrides.find((candidate) => candidate.aircoId === String(aircoId));
    return entry ? structuredClone(entry) : null;
  }

  setManualOverride(value) {
    const entry = normalizeManualOverride(value);
    const existing = this.state.manualOverrides.find((candidate) => candidate.aircoId === entry.aircoId);
    if (existing) return structuredClone(existing);
    this.state.manualOverrides.push(entry);
    this.save();
    return structuredClone(entry);
  }

  removeManualOverride(aircoId) {
    const index = this.state.manualOverrides.findIndex((candidate) => candidate.aircoId === String(aircoId));
    if (index < 0) return null;
    const [removed] = this.state.manualOverrides.splice(index, 1);
    this.save();
    return structuredClone(removed);
  }
}

module.exports = {
  ACTION_TYPES,
  AutomationStore,
  CONDITION_TYPES,
  LOGIC_TYPES,
  normalizeAutomation,
  normalizeManualOverride,
  normalizePendingClean,
  temperatureShortcutGraph,
};
