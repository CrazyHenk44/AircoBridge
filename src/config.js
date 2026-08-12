"use strict";

const fs = require("fs");

function parseBool(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseIntValue(value, defaultValue) {
  const n = Number(value);
  return Number.isFinite(n) ? n : defaultValue;
}

function parseList(value) {
  if (value === undefined || value === null) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeAirco(raw, idx) {
  const id = raw.id || raw.name || `airco-${idx + 1}`;
  const airco = {
    id: String(id),
    name: raw.name || String(id),
    ip: raw.ip,
    port: parseIntValue(raw.port, 51443),
    deviceId: raw.deviceId,
    operatorId: raw.operatorId,
    airconId: raw.airconId === undefined ? "1" : String(raw.airconId),
    httpsMode: raw.httpsMode === undefined ? true : Boolean(raw.httpsMode),
    pollIntervalMs: parseIntValue(raw.pollIntervalMs, 30000),
    timeoutMs: parseIntValue(raw.timeoutMs, 10000),
  };

  for (const field of ["ip", "deviceId", "operatorId"]) {
    if (!airco[field]) throw new Error(`aircos[${idx}].${field} is required`);
  }

  return airco;
}

function loadConfig() {
  let raw;
  let configFile = null;
  if (process.env.AIRCO_CONFIG_JSON) {
    raw = JSON.parse(process.env.AIRCO_CONFIG_JSON);
  } else {
    const path = process.env.AIRCO_CONFIG_FILE || "config/aircos.json";
    if (fs.existsSync(path)) {
      raw = JSON.parse(fs.readFileSync(path, "utf8"));
      configFile = path;
    }
  }

  if (!raw && process.env.WF_IP && process.env.WF_DEVICE_ID && process.env.WF_OPERATOR_ID) {
    raw = {
      server: {},
      aircos: [{
        id: process.env.WF_ID || "living-room",
        name: process.env.WF_NAME || "Air conditioner",
        ip: process.env.WF_IP,
        port: parseIntValue(process.env.WF_PORT, 51443),
        deviceId: process.env.WF_DEVICE_ID,
        operatorId: process.env.WF_OPERATOR_ID,
        airconId: process.env.WF_AIRCON_ID || "1",
        httpsMode: parseBool(process.env.WF_HTTPS, true),
        pollIntervalMs: parseIntValue(process.env.WF_POLL_INTERVAL_MS, 30000),
        timeoutMs: parseIntValue(process.env.WF_TIMEOUT_MS, 10000),
      }],
    };
  }

  if (!raw) {
    throw new Error("No config found. Set AIRCO_CONFIG_FILE, AIRCO_CONFIG_JSON, or WF_IP/WF_DEVICE_ID/WF_OPERATOR_ID.");
  }

  const server = raw.server || {};
  const aircos = Array.isArray(raw.aircos) ? raw.aircos.map(normalizeAirco) : [];

  return {
    server: {
      host: process.env.HOST || server.host || "0.0.0.0",
      port: parseIntValue(process.env.PORT || server.port, 3000),
    },
    historyFile: process.env.AIRCO_HISTORY_FILE || server.historyFile || "data/airco-history.json",
    presetsFile: process.env.AIRCO_PRESETS_FILE || server.presetsFile || "data/airco-presets.json",
    discovery: {
      enabled: parseBool(process.env.AIRCO_MDNS_ENABLED, true),
      idFile: process.env.AIRCO_BRIDGE_ID_FILE || server.bridgeIdFile || "data/bridge-id",
      interfaces: parseList(process.env.AIRCO_MDNS_INTERFACE || server.mdnsInterface),
    },
    aircos,
    configFile,
  };
}

function appendAircoToFile(configFile, entry) {
  const raw = JSON.parse(fs.readFileSync(configFile, "utf8"));
  if (!Array.isArray(raw.aircos)) raw.aircos = [];
  raw.aircos.push(entry);
  fs.writeFileSync(configFile, `${JSON.stringify(raw, null, 2)}\n`);
}

function removeAircoFromFile(configFile, id) {
  const raw = JSON.parse(fs.readFileSync(configFile, "utf8"));
  if (!Array.isArray(raw.aircos)) return;
  raw.aircos = raw.aircos.filter((airco, idx) => String(airco.id || airco.name || `airco-${idx + 1}`) !== String(id));
  fs.writeFileSync(configFile, `${JSON.stringify(raw, null, 2)}\n`);
}

module.exports = { loadConfig, normalizeAirco, appendAircoToFile, removeAircoFromFile };
