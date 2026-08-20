"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { createAddressReconciler } = require("./address-reconciler");
const { AircoManager } = require("./airco-manager");
const { AutomationEngine } = require("./automation-engine");
const { AutomationLogStore } = require("./automation-log-store");
const { AutomationStore } = require("./automation-store");
const { loadOrCreateBridgeId } = require("./bridge-identity");
const { loadConfig, normalizeAirco, appendAircoToFile, removeAircoFromFile } = require("./config");
const { startDiscovery } = require("./discovery");
const { PresetStore, applyPresetSettings } = require("./preset-store");
const { BRIDGE_DEVICE_PREFIX, probeUnit, registerOperator, unregisterOperator, testConnection } = require("./registration");
const { createUnitDiscoverer } = require("./unit-discovery");
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

function withAutomationOverride(snapshot, automationEngine, aircoId) {
  if (typeof automationEngine?.manualOverride !== "function") return snapshot;
  return {
    ...snapshot,
    automationOverride: automationEngine.manualOverride(aircoId),
  };
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
    discoveryId: body.discoveryId ? String(body.discoveryId).trim().toLowerCase() : undefined,
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

async function routeApi(req, res, manager, configFile, presetStore, bridgeId, unitDiscoverer, automationEngine) {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/api/info") {
    const info = {
      name: "AircoBridge",
      bridgeVersion: BRIDGE_VERSION,
      apiVersion: 1,
      features: {
        discovery: Boolean(bridgeId),
        unitDiscovery: Boolean(unitDiscoverer),
        presets: true,
        globalPresets: true,
        automations: Boolean(automationEngine),
        automationLog: Boolean(automationEngine?.logStore),
        manualOverride: typeof automationEngine?.activateManualOverride === "function",
      },
    };
    if (bridgeId) info.bridgeId = bridgeId;
    return sendJson(res, 200, info);
  }

  if (req.method === "GET" && url.pathname === "/api/aircos") {
    const aircos = manager.list().map((item) => ({
      ...item,
      presets: presetStore.list(item.airco.id),
    })).map((item) => withAutomationOverride(item, automationEngine, item.airco.id));
    return sendJson(res, 200, { aircos });
  }

  if (req.method === "GET" && url.pathname === "/api/setup/discover") {
    if (!unitDiscoverer) return sendJson(res, 200, { units: [], disabled: true });
    const configured = typeof manager.configs === "function" ? manager.configs() : [];
    const units = (await unitDiscoverer()).map((unit) => ({
      ...unit,
      configured: configured.some((airco) => (
        (unit.discoveryId && airco.discoveryId === unit.discoveryId)
          || (airco.ip === unit.ip && Number(airco.port) === unit.port)
      )),
    }));
    return sendJson(res, 200, { units });
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "setup" && parts[2]) {
    return routeSetup(req, res, parts[2], await readBody(req));
  }

  if (req.method === "POST" && url.pathname === "/api/aircos") {
    return addAirco(res, manager, configFile, await readBody(req));
  }

  if (url.pathname === "/api/automation-log") {
    if (!automationEngine?.logStore) return sendJson(res, 404, { error: "Automation activity is not available" });
    if (req.method === "GET") {
      return sendJson(res, 200, {
        entries: automationEngine.listLog({
          limit: url.searchParams.get("limit") || 100,
          automationId: url.searchParams.get("automationId") || null,
        }),
      });
    }
    if (req.method === "DELETE") return sendJson(res, 200, { removed: automationEngine.clearLog() });
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  if (url.pathname === "/api/automations") {
    if (!automationEngine) return sendJson(res, 404, { error: "Automations are not available" });
    if (req.method === "GET") return sendJson(res, 200, { automations: automationEngine.list() });
    if (req.method === "POST") return sendJson(res, 201, automationEngine.create(await readBody(req)));
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  if (url.pathname === "/api/automations/temperature-shortcut") {
    if (!automationEngine) return sendJson(res, 404, { error: "Automations are not available" });
    if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
    return sendJson(res, 201, automationEngine.createTemperatureShortcut(await readBody(req)));
  }

  if (parts[0] === "api" && parts[1] === "automations" && parts[2] && !parts[3]) {
    if (!automationEngine) return sendJson(res, 404, { error: "Automations are not available" });
    if (req.method === "GET") return sendJson(res, 200, automationEngine.get(parts[2]));
    if (req.method === "PUT") return sendJson(res, 200, automationEngine.update(parts[2], await readBody(req)));
    if (req.method === "DELETE") return sendJson(res, 200, { removed: automationEngine.remove(parts[2]) });
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  if (parts[0] !== "api" || parts[1] !== "aircos" || !parts[2]) {
    return sendJson(res, 404, { error: "Not found" });
  }

  const runtime = manager.get(parts[2]);
  const aircoId = runtime.config?.id || parts[2];
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
      const body = await readBody(req);
      const preset = presetStore.get(runtime.config.id, presetId);
      const snapshot = await runtime.update((status) => applyPresetSettings(status, preset.settings));
      runtime.vacantPresetRestoreState = null;
      if (body.automationOverride !== false) {
        automationEngine?.activateManualOverride?.(aircoId, { source: "preset" });
      }
      automationEngine?.acknowledgeControlState?.(aircoId);
      return sendJson(res, 200, withAutomationOverride({ ...snapshot, appliedPreset: preset }, automationEngine, aircoId));
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
    return sendJson(res, 200, withAutomationOverride(snapshot, automationEngine, aircoId));
  }

  if (req.method === "DELETE" && !action) {
    automationEngine?.clearManualOverride?.(aircoId, { reason: "The air conditioner was removed." });
    return deleteAirco(res, manager, configFile, presetStore, runtime);
  }

  if (action === "automation-override") {
    if (!automationEngine?.activateManualOverride || !automationEngine?.clearManualOverride) {
      return sendJson(res, 404, { error: "Manual automation override is not available" });
    }
    if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
    const body = await readBody(req);
    const active = boolFromValue(body.active ?? body.value, "active");
    if (active) {
      const snapshot = runtime.snapshot();
      const isOn = snapshot?.status?.power === "on" || snapshot?.status?.operation === true;
      if (!isOn) {
        return sendJson(res, 409, { error: "Switch on the air conditioner before starting manual control" });
      }
      automationEngine.activateManualOverride(aircoId, { source: "api" });
    } else {
      automationEngine.clearManualOverride(aircoId);
    }
    return sendJson(res, 200, withAutomationOverride(runtime.snapshot(), automationEngine, aircoId));
  }

  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });

  const body = await readBody(req);

  if (action === "refresh") {
    return sendJson(res, 200, withAutomationOverride(await runtime.refresh(), automationEngine, aircoId));
  }

  const requestedPower = action === "power"
    ? boolFromPayload(body)
    : action === "settings" && ("operation" in body || "power" in body) ? boolFromPayload(body) : null;
  const result = await runtime.update((status) => {
    if (action === "power") status.setPower(requestedPower);
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
      if ("operation" in body || "power" in body) status.setPower(requestedPower);
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

  if (requestedPower === false) {
    automationEngine?.clearManualOverride?.(aircoId, {
      reason: "The air conditioner was switched off manually; automation control resumed automatically.",
    });
  } else if (body.automationOverride !== false && (requestedPower === true
    || (["temperature", "mode", "airflow", "settings"].includes(action)
      && (result?.status?.power === "on" || result?.status?.operation === true)))) {
    automationEngine?.activateManualOverride?.(aircoId, { source: action });
  }
  automationEngine?.acknowledgeControlState?.(aircoId);

  return sendJson(res, 200, withAutomationOverride(result, automationEngine, aircoId));
}

function createServer(
  manager,
  {
    configFile = null,
    presetStore = new PresetStore(),
    bridgeId = null,
    unitDiscoverer = null,
    automationEngine = null,
  } = {}
) {
  return http.createServer((req, res) => {
    if (req.url.startsWith("/api/")) {
      routeApi(req, res, manager, configFile, presetStore, bridgeId, unitDiscoverer, automationEngine)
        .catch((err) => sendError(res, err));
      return;
    }
    serveStatic(req, res);
  });
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function main() {
  const config = loadConfig();
  const bridgeId = loadOrCreateBridgeId(config.discovery.idFile);
  const manager = new AircoManager(config.aircos, config.historyFile);
  const presetStore = new PresetStore(config.presetsFile);
  const automationStore = new AutomationStore(config.automationsFile);
  const automationLogStore = new AutomationLogStore(config.automationLogFile);
  const automationEngine = new AutomationEngine(manager, presetStore, automationStore, {
    logStore: automationLogStore,
  });
  const unitDiscoverer = config.discovery.enabled
    ? createUnitDiscoverer({ interfaces: config.discovery.interfaces })
    : null;
  const addressReconciler = unitDiscoverer
    ? createAddressReconciler(manager, { discoverUnits: unitDiscoverer, configFile: config.configFile })
    : null;
  if (addressReconciler) manager.setAddressRecovery((airco) => addressReconciler.recover(airco));
  const server = createServer(manager, {
    configFile: config.configFile,
    presetStore,
    bridgeId,
    unitDiscoverer,
    automationEngine,
  });

  manager.start();
  automationEngine.start();
  await listen(server, config.server.port, config.server.host);
  console.log(`airco service listening on http://${config.server.host}:${config.server.port}`);
  if (addressReconciler) {
    addressReconciler.reconcile({ force: true }).catch((err) => {
      console.warn(`Initial WF-RAC mDNS reconciliation failed: ${err.message || err}`);
    });
  }

  let discovery = null;
  if (config.discovery.enabled) {
    try {
      discovery = await startDiscovery({
        bridgeId,
        port: config.server.port,
        version: BRIDGE_VERSION,
        interfaces: config.discovery.interfaces,
      });
      const target = discovery.interfaces.length > 0
        ? ` on ${discovery.interfaces.join(", ")}`
        : "";
      console.log(`mDNS discovery advertising ${discovery.serviceName}${target}`);
    } catch (err) {
      console.error(`mDNS discovery could not be started: ${err.message || err}`);
    }
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    automationEngine.stop();
    manager.stop();
    if (discovery) await discovery.stop().catch((err) => console.error(`mDNS shutdown failed: ${err.message || err}`));
    await closeServer(server);
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message || err);
    process.exit(1);
  });
}

module.exports = { createServer };
