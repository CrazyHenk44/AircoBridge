"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_PRESETS_PER_AIRCO = 50;

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function normalizeName(value) {
  const name = String(value || "").trim();
  if (!name) throw httpError("Preset name is required", 400);
  if (name.length > 40) throw httpError("Preset name cannot be longer than 40 characters", 400);
  return name;
}

function integerInRange(value, min, max, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`Invalid preset ${field}`);
  }
  return number;
}

function booleanValue(value, field) {
  if (value !== true && value !== false) throw new Error(`Invalid preset ${field}`);
  return value;
}

function normalizeSettings(value) {
  if (!value || typeof value !== "object") throw new Error("Invalid preset settings");

  const temperature = Number(value.temperature);
  if (!Number.isFinite(temperature) || temperature < 10 || temperature > 30 || temperature * 2 % 1 !== 0) {
    throw new Error("Invalid preset temperature");
  }

  const mode = String(value.mode || "").toLowerCase();
  if (!["auto", "cool", "heat", "fan", "dry"].includes(mode)) throw new Error("Invalid preset mode");

  const airflow = String(value.airflow || "").toLowerCase();
  if (!["auto", "lowest", "low", "high", "highest"].includes(airflow)) {
    throw new Error("Invalid preset airflow");
  }

  return {
    // Applying a preset always starts the air conditioner. Keeping this field in the
    // persisted shape also migrates presets that were originally captured while off.
    power: true,
    temperature,
    mode,
    airflow,
    windDirectionUD: integerInRange(value.windDirectionUD, 0, 4, "windDirectionUD"),
    windDirectionLR: integerInRange(value.windDirectionLR, 0, 7, "windDirectionLR"),
    entrust: booleanValue(value.entrust, "entrust"),
    coolHotJudge: booleanValue(value.coolHotJudge, "coolHotJudge"),
    vacant: booleanValue(value.vacant, "vacant"),
  };
}

function normalizePreset(value) {
  if (!value || typeof value !== "object" || !value.id) throw new Error("Invalid preset");
  return {
    id: String(value.id),
    name: normalizeName(value.name),
    settings: normalizeSettings(value.settings),
    createdAt: new Date(value.createdAt || Date.now()).toISOString(),
  };
}

function applyPresetSettings(status, settings) {
  status.setMode(settings.mode);
  status.presetTemp = settings.temperature;
  status.setAirFlow(settings.airflow);
  status.setWindDirectionUD(settings.windDirectionUD);
  status.setWindDirectionLR(settings.windDirectionLR);
  status.setEntrust(settings.entrust);
  status.setVacantProperty(settings.vacant);
  status.coolHotJudge = settings.coolHotJudge;
  status.setPower(true);
}

class PresetStore {
  constructor(filePath = "data/airco-presets.json") {
    this.filePath = filePath;
    this.state = this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return { version: 1, aircos: {} };
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!parsed || typeof parsed !== "object") throw new Error("Invalid preset file");
      const aircos = {};
      for (const [aircoId, presets] of Object.entries(parsed.aircos || {})) {
        if (!Array.isArray(presets)) continue;
        aircos[aircoId] = presets.flatMap((preset) => {
          try {
            return [normalizePreset(preset)];
          } catch {
            return [];
          }
        });
      }
      return { version: 1, aircos };
    } catch {
      return { version: 1, aircos: {} };
    }
  }

  save() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryFile = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryFile, `${JSON.stringify(this.state, null, 2)}\n`);
    fs.renameSync(temporaryFile, this.filePath);
  }

  list(aircoId) {
    return (this.state.aircos[String(aircoId)] || []).map((preset) => structuredClone(preset));
  }

  get(aircoId, presetId) {
    const preset = (this.state.aircos[String(aircoId)] || [])
      .find((candidate) => candidate.id === String(presetId));
    if (!preset) throw httpError("Unknown preset", 404);
    return structuredClone(preset);
  }

  createMany(aircoIds, nameValue, settingsValue, now = new Date()) {
    const name = normalizeName(nameValue);
    const settings = normalizeSettings(settingsValue);
    const ids = [...new Set(aircoIds.map((id) => String(id)))];
    if (ids.length === 0) throw httpError("No air conditioners configured", 400);

    for (const aircoId of ids) {
      const presets = this.state.aircos[aircoId] || [];
      if (presets.length >= MAX_PRESETS_PER_AIRCO) {
        throw httpError(`Air conditioner ${aircoId} already has ${MAX_PRESETS_PER_AIRCO} presets`, 409);
      }
      if (presets.some((preset) => preset.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0)) {
        throw httpError(`A preset named "${name}" already exists for ${aircoId}`, 409);
      }
    }

    const createdAt = now.toISOString();
    const created = ids.map((aircoId) => ({
      aircoId,
      preset: {
        id: crypto.randomUUID(),
        name,
        settings: { ...settings },
        createdAt,
      },
    }));

    for (const { aircoId, preset } of created) {
      if (!this.state.aircos[aircoId]) this.state.aircos[aircoId] = [];
      this.state.aircos[aircoId].push(preset);
    }
    this.save();
    return structuredClone(created);
  }

  remove(aircoId, presetId) {
    const id = String(aircoId);
    const presets = this.state.aircos[id] || [];
    const index = presets.findIndex((preset) => preset.id === String(presetId));
    if (index < 0) throw httpError("Unknown preset", 404);
    const [removed] = presets.splice(index, 1);
    if (presets.length === 0) delete this.state.aircos[id];
    this.save();
    return structuredClone(removed);
  }

  removeAirco(aircoId) {
    const id = String(aircoId);
    if (!this.state.aircos[id]) return;
    delete this.state.aircos[id];
    this.save();
  }
}

module.exports = { PresetStore, applyPresetSettings, normalizeSettings };
