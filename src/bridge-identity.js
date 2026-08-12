"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function readBridgeId(file) {
  const bridgeId = fs.readFileSync(file, "utf8").trim().toLowerCase();
  if (!bridgeId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(bridgeId)) {
    throw new Error(`Invalid bridge ID in ${file}`);
  }
  return bridgeId;
}

function loadOrCreateBridgeId(file) {
  if (fs.existsSync(file)) return readBridgeId(file);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bridgeId = crypto.randomUUID();

  try {
    fs.writeFileSync(file, `${bridgeId}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return bridgeId;
  } catch (err) {
    if (err.code === "EEXIST") return readBridgeId(file);
    throw err;
  }
}

module.exports = { loadOrCreateBridgeId, readBridgeId };
