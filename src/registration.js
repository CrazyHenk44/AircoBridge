"use strict";

const crypto = require("crypto");
const { WfracClient } = require("./wfrac");

const BRIDGE_DEVICE_PREFIX = "airco-bridge-";

function generateIdentity() {
  return {
    deviceId: `${BRIDGE_DEVICE_PREFIX}${crypto.randomBytes(6).toString("hex")}`,
    operatorId: crypto.randomUUID(),
  };
}

function localTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC";
  } catch {
    return "Etc/UTC";
  }
}

function buildClient({ ip, port, httpsMode = true, timeoutMs = 10000, deviceId, operatorId, airconId = "1" }) {
  return new WfracClient({ ip, port, httpsMode, timeoutMs, deviceId, operatorId, airconId });
}

async function probeUnit(target) {
  const client = buildClient({ ...generateIdentity(), ...target });
  return client.getDeviceInfo();
}

async function registerOperator(target) {
  const identity = {
    deviceId: target.deviceId || generateIdentity().deviceId,
    operatorId: target.operatorId || generateIdentity().operatorId,
  };
  const client = buildClient({ ...target, ...identity });

  const info = await client.getDeviceInfo();
  if (info?.airconId) client.airconId = String(info.airconId);

  const result = await client.registerAccount(localTimezone());
  if (Number(result?.result) === 2) {
    const err = new Error(
      "The unit refused the registration: its operator list is full. " +
      "Remove an unused account in the Smart M-Air app and try again."
    );
    err.statusCode = 409;
    throw err;
  }
  if (Number(result?.result) !== 0) {
    throw new Error(`Registration failed: ${JSON.stringify(result)}`);
  }

  return {
    deviceId: identity.deviceId,
    operatorId: identity.operatorId,
    airconId: client.airconId,
    deviceInfo: info,
  };
}

async function unregisterOperator(target) {
  const client = buildClient(target);
  return client.deleteAccount();
}

async function testConnection(target) {
  const client = buildClient(target);
  const { status } = await client.getStatus();
  return status.toJSON();
}

module.exports = { BRIDGE_DEVICE_PREFIX, generateIdentity, localTimezone, probeUnit, registerOperator, unregisterOperator, testConnection };
