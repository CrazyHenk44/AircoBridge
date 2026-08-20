"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_ENTRIES = 500;

function safeText(value, fallback = "") {
  const normalized = String(value ?? fallback).trim();
  return normalized.slice(0, 500);
}

function normalizeCondition(value) {
  return {
    nodeId: safeText(value?.nodeId),
    type: safeText(value?.type),
    result: value?.result === true ? true : value?.result === false ? false : null,
    message: safeText(value?.message),
    actual: Number.isFinite(Number(value?.actual)) ? Number(value.actual) : null,
  };
}

function normalizeEntry(value) {
  if (!value || typeof value !== "object") throw new Error("Invalid automation log entry");
  const time = new Date(value.time || Date.now());
  if (Number.isNaN(time.getTime())) throw new Error("Invalid automation log time");
  return {
    id: safeText(value.id || crypto.randomUUID()),
    time: time.toISOString(),
    automationId: safeText(value.automationId),
    automationName: safeText(value.automationName, "Automation"),
    actionNodeId: value.actionNodeId ? safeText(value.actionNodeId) : null,
    event: safeText(value.event, "activity"),
    level: ["info", "warning", "error"].includes(value.level) ? value.level : "info",
    title: safeText(value.title, "Automation activity"),
    message: safeText(value.message),
    action: value.action && typeof value.action === "object" ? structuredClone(value.action) : null,
    conditions: Array.isArray(value.conditions) ? value.conditions.map(normalizeCondition).slice(0, 40) : [],
  };
}

class AutomationLogStore {
  constructor(filePath = "data/airco-automation-log.json", maxEntries = MAX_ENTRIES) {
    this.filePath = filePath;
    this.maxEntries = maxEntries;
    this.state = this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return { version: 1, entries: [] };
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
        throw new Error("Invalid automation log file");
      }
      const entries = parsed.entries.flatMap((entry) => {
        try {
          return [normalizeEntry(entry)];
        } catch {
          return [];
        }
      }).slice(-this.maxEntries);
      return { version: 1, entries };
    } catch {
      return { version: 1, entries: [] };
    }
  }

  save() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryFile = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryFile, `${JSON.stringify(this.state, null, 2)}\n`);
    fs.renameSync(temporaryFile, this.filePath);
  }

  append(value) {
    const entry = normalizeEntry(value);
    this.state.entries.push(entry);
    this.state.entries = this.state.entries.slice(-this.maxEntries);
    this.save();
    return structuredClone(entry);
  }

  list({ limit = 100, automationId = null } = {}) {
    const normalizedLimit = Math.max(1, Math.min(this.maxEntries, Number(limit) || 100));
    const entries = automationId
      ? this.state.entries.filter((entry) => entry.automationId === String(automationId))
      : this.state.entries;
    return structuredClone(entries.slice(-normalizedLimit).reverse());
  }

  clear() {
    const removed = this.state.entries.length;
    this.state.entries = [];
    this.save();
    return removed;
  }
}

module.exports = { AutomationLogStore, normalizeEntry };
