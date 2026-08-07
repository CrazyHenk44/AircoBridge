"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { AircoManager } = require("./airco-manager");
const { loadConfig, normalizeAirco, appendAircoToFile, removeAircoFromFile } = require("./config");
const { PresetStore } = require("./preset-store");
const { BRIDGE_DEVICE_PREFIX, probeUnit, registerOperator, unregisterOperator, testConnection } = require("./registration");
const { version: BRIDGE_VERSION } = require("../package.json");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function sendJson(res, statusCode, body) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function sendError(res, err) {
  sendJson(res, err.statusCode || 500, { error: err.message || String(err) });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        reject(Object.assign(new Error("Request body is too large"), { statusCode: 413 }));
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  const urlPath = new URL(req.url, "http://localhost").pathname;
  const file = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const resolved = path.normalize(path.join(PUBLIC_DIR, file));
  const relative = path.relative(PUBLIC_DIR, resolved);

  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    res.writeHead(403, SECURITY_HEADERS);
    res.end("Forbidden");
    return;
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, SECURITY_HEADERS);
      res.end("Not found");
      return;
    }

    const ext = path.extname(resolved);
    const type = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
    }[ext] || "application/octet-stream";

    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": type });
    res.end(data);
  });
}

function boolFromPayload(body) {
  if ("operation" in body) return boolFromValue(body.operation, "operation");
  if ("power" in body) return boolFromValue(body.power, "power");
  if ("value" in body) return boolFromValue(body.value);
  throw Object.assign(new Error("Expected power, operation, or value"), { statusCode: 400 });
}

function boolFromValue(value, field = "value") {
  if (value === true || value === false) return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["on", "true", "1"].includes(normalized)) return true;
  if (["off", "false", "0"].includes(normalized)) return false;
  throw Object.assign(new Error(`Expected boolean-like ${field}`), { statusCode: 400 });
}

function captureVacantRestoreState(status) {
  return {
    operation: Boolean(status.operation),
    operationMode: status.operationMode,
    presetTemp: status.presetTemp,
    airFlow: status.airFlow,
    windDirectionUD: status.windDirectionUD,
    windDirectionLR: status.windDirectionLR,
    entrust: status.entrust,
    coolHotJudge: status.coolHotJudge,
    isVacantProperty: status.isVacantProperty,
  };
}

function applyVacantRestoreState(status, restore) {
  status.operation = Boolean(restore.operation);
  status.operationMode = restore.operationMode;
  status.presetTemp = restore.presetTemp;
  status.airFlow = restore.airFlow;
  status.windDirectionUD = restore.windDirectionUD;
  status.windDirectionLR = restore.windDirectionLR;
  status.entrust = restore.entrust;
  status.coolHotJudge = restore.coolHotJudge;
  status.isVacantProperty = restore.isVacantProperty ? 1 : 0;
}

function capturePresetSettings(status) {
  return {
    power: true,
    temperature: status.presetTemp,
    mode: status.operationModeName,
    airflow: status.airFlowName,
    windDirectionUD: status.windDirectionUD,
    windDirectionLR: status.windDirectionLR,
    entrust: Boolean(status.entrust),
    coolHotJudge: Boolean(status.coolHotJudge),
    vacant: Boolean(status.isVacantProperty),
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

function setupTarget(body) {
  const ip = String(body.ip || "").trim();
  if (!ip) throw Object.assign(new Error("ip is required"), { statusCode: 400 });
  const port = Number(body.port || 51443);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error("Invalid port"), { statusCode: 400 });
  }
  return { ip, port, httpsMode: body.httpsMode === undefined ? true : Boolean(body.httpsMode), timeoutMs: 8000 };
}

function slugFromName(name, manager) {
  const base = String(name)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "airco";
  let slug = base;
  for (let n = 2; manager.has(slug); n += 1) slug = `${base}-${n}`;
  return slug;
}

async function routeSetup(req, res, action, body) {
  const target = setupTarget(body);

  if (action === "probe") {
    return sendJson(res, 200, await probeUnit(target));
  }
  if (action === "register") {
    return sendJson(res, 200, await registerOperator(target));
  }
  if (action === "test") {
    if (!body.deviceId || !body.operatorId) {
      throw Object.assign(new Error("deviceId and operatorId are required"), { statusCode: 400 });
    }
    const status = await testConnection({
      ...target,
      deviceId: String(body.deviceId).trim(),
      operatorId: String(body.operatorId).trim(),
      airconId: body.airconId ? String(body.airconId).trim() : "1",
    });
    return sendJson(res, 200, { ok: true, status });
  }
  if (action === "unregister") {
    if (!body.deviceId || !body.operatorId) {
      throw Object.assign(new Error("deviceId and operatorId are required"), { statusCode: 400 });
    }
    const result = await unregisterOperator({
      ...target,
      deviceId: String(body.deviceId).trim(),
      operatorId: String(body.operatorId).trim(),
      airconId: body.airconId ? String(body.airconId).trim() : "1",
    });
    return sendJson(res, 200, result);
  }

  return sendJson(res, 404, { error: "Not found" });
}

async function addAirco(res, manager, configFile, body) {
  const name = String(body.name || "").trim();
  if (!name) throw Object.assign(new Error("name is required"), { statusCode: 400 });
  if (!configFile) {
    throw Object.assign(
      new Error("Configuration is not file-based; add the air conditioner to your config source manually."),
      { statusCode: 400 }
    );
  }

  const entry = {
    id: slugFromName(name, manager),
    name,
    ip: String(body.ip || "").trim(),
    port: Number(body.port || 51443),
    deviceId: String(body.deviceId || "").trim(),
    operatorId: String(body.operatorId || "").trim(),
    airconId: body.airconId ? String(body.airconId).trim() : "1",
    httpsMode: body.httpsMode === undefined ? true : Boolean(body.httpsMode),
    pollIntervalMs: 30000,
    timeoutMs: 10000,
  };

  let config;
  try {
    config = normalizeAirco(entry, 0);
  } catch (err) {
    err.statusCode = 400;
    throw err;
  }

  appendAircoToFile(configFile, entry);
  const runtime = manager.add(config);
  await runtime.refresh().catch(() => {});
  return sendJson(res, 201, runtime.snapshot());
}

async function deleteAirco(res, manager, configFile, presetStore, runtime) {
  if (!configFile) {
    throw Object.assign(
      new Error("Configuration is not file-based; remove the air conditioner from your config source manually."),
      { statusCode: 400 }
    );
  }

  const config = runtime.config;
  manager.remove(config.id);
  removeAircoFromFile(configFile, config.id);
  presetStore.removeAirco(config.id);

  let accountDeleted = null;
  const createdByBridge = String(config.deviceId).startsWith(BRIDGE_DEVICE_PREFIX);
  if (createdByBridge && !manager.identityShared(config)) {
    try {
      const result = await unregisterOperator({
        ip: config.ip,
        port: config.port,
        httpsMode: config.httpsMode,
        timeoutMs: 8000,
        deviceId: config.deviceId,
        operatorId: config.operatorId,
        airconId: config.airconId,
      });
      accountDeleted = Number(result?.result) === 0;
    } catch {
      accountDeleted = false;
    }
  }

  return sendJson(res, 200, { removed: config.id, accountDeleted });
}

async function routeApi(req, res, manager, configFile, presetStore) {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/api/info") {
    return sendJson(res, 200, {
      name: "AircoBridge",
      bridgeVersion: BRIDGE_VERSION,
      apiVersion: 1,
      features: {
        presets: true,
        globalPresets: true,
      },
    });
  }

  if (req.method === "GET" && url.pathname === "/api/aircos") {
    const aircos = manager.list().map((item) => ({
      ...item,
      presets: presetStore.list(item.airco.id),
    }));
    return sendJson(res, 200, { aircos });
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "setup" && parts[2]) {
    return routeSetup(req, res, parts[2], await readBody(req));
  }

  if (req.method === "POST" && url.pathname === "/api/aircos") {
    return addAirco(res, manager, configFile, await readBody(req));
  }

  if (parts[0] !== "api" || parts[1] !== "aircos" || !parts[2]) {
    return sendJson(res, 404, { error: "Not found" });
  }

  const runtime = manager.get(parts[2]);
  const action = parts[3];
  const presetId = parts[4];

  if (action === "presets") {
    if (req.method === "GET" && !presetId) {
      return sendJson(res, 200, { presets: presetStore.list(runtime.config.id) });
    }
    if (req.method === "DELETE" && presetId && !parts[5]) {
      return sendJson(res, 200, { removed: presetStore.remove(runtime.config.id, presetId) });
    }
    if (req.method === "POST" && !presetId) {
      const body = await readBody(req);
      const status = runtime.snapshot().status;
      if (!status) {
        throw Object.assign(new Error("No air conditioner status available to save"), { statusCode: 409 });
      }
      const aircoIds = body.global === true ? manager.configs().map((config) => config.id) : [runtime.config.id];
      const created = presetStore.createMany(aircoIds, body.name, capturePresetSettings(status));
      return sendJson(res, 201, { created });
    }
    if (req.method === "POST" && presetId && parts[5] === "apply") {
      await readBody(req);
      const preset = presetStore.get(runtime.config.id, presetId);
      const snapshot = await runtime.update((status) => applyPresetSettings(status, preset.settings));
      runtime.vacantPresetRestoreState = null;
      return sendJson(res, 200, { ...snapshot, appliedPreset: preset });
    }
    return sendJson(res, req.method === "GET" || req.method === "POST" || req.method === "DELETE" ? 404 : 405, {
      error: req.method === "GET" || req.method === "POST" || req.method === "DELETE" ? "Not found" : "Method not allowed",
    });
  }

  if (req.method === "GET" && !action) {
    const snapshot = runtime.snapshot({
      includeRaw: url.searchParams.get("raw") === "1",
      includeDebug: url.searchParams.get("debug") === "1",
    });
    snapshot.presets = presetStore.list(runtime.config.id);
    return sendJson(res, 200, snapshot);
  }

  if (req.method === "DELETE" && !action) {
    return deleteAirco(res, manager, configFile, presetStore, runtime);
  }

  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });

  const body = await readBody(req);

  if (action === "refresh") {
    return sendJson(res, 200, await runtime.refresh());
  }

  const result = await runtime.update((status) => {
    if (action === "power") status.setPower(boolFromPayload(body));
    else if (action === "temperature") status.setTargetTemp(body.temperature ?? body.presetTemp ?? body.value);
    else if (action === "mode") status.setMode(body.mode ?? body.operationMode ?? body.value);
    else if (action === "airflow") status.setAirFlow(body.airflow ?? body.airFlow ?? body.value);
    else if (action === "entrust") status.setEntrust(body.entrust ?? body.value);
    else if (action === "vacant") status.setVacantProperty(body.vacant ?? body.value);
    else if (action === "vacant-preset") {
      const enabled = boolFromValue(body.vacant ?? body.value, "vacant");
      if (enabled) {
        if (!status.isVacantProperty) {
          runtime.vacantPresetRestoreState = captureVacantRestoreState(status);
        }
        status.setVacantPreset(true);
      } else if (runtime.vacantPresetRestoreState) {
        applyVacantRestoreState(status, runtime.vacantPresetRestoreState);
        runtime.vacantPresetRestoreState = null;
      } else {
        status.setVacantPreset(false);
      }
    }
    else if (action === "vane") {
      if ("windDirectionUD" in body) status.setWindDirectionUD(body.windDirectionUD);
      if ("windDirectionLR" in body) status.setWindDirectionLR(body.windDirectionLR);
    } else if (action === "settings") {
      if ("operation" in body || "power" in body) status.setPower(boolFromPayload(body));
      if ("temperature" in body || "presetTemp" in body) status.setTargetTemp(body.temperature ?? body.presetTemp);
      if ("mode" in body || "operationMode" in body) status.setMode(body.mode ?? body.operationMode);
      if ("airflow" in body || "airFlow" in body) status.setAirFlow(body.airflow ?? body.airFlow);
      if ("entrust" in body) status.setEntrust(boolFromValue(body.entrust, "entrust"));
      if ("windDirectionUD" in body) status.setWindDirectionUD(body.windDirectionUD);
      if ("windDirectionLR" in body) status.setWindDirectionLR(body.windDirectionLR);
    } else {
      const err = new Error("Unknown action");
      err.statusCode = 404;
      throw err;
    }
  });

  return sendJson(res, 200, result);
}

function createServer(manager, { configFile = null, presetStore = new PresetStore() } = {}) {
  return http.createServer((req, res) => {
    if (req.url.startsWith("/api/")) {
      routeApi(req, res, manager, configFile, presetStore).catch((err) => sendError(res, err));
      return;
    }
    serveStatic(req, res);
  });
}

function main() {
  const config = loadConfig();
  const manager = new AircoManager(config.aircos, config.historyFile);
  const presetStore = new PresetStore(config.presetsFile);
  const server = createServer(manager, { configFile: config.configFile, presetStore });

  manager.start();

  server.listen(config.server.port, config.server.host, () => {
    console.log(`airco service listening on http://${config.server.host}:${config.server.port}`);
  });

  const shutdown = () => {
    manager.stop();
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.stack || err.message || err);
    process.exit(1);
  }
}

module.exports = { createServer };
