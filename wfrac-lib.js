"use strict";

const { WfracClient } = require("./src/wfrac");
const { generateIdentity, registerOperator } = require("./src/registration");

function buildClientFromEnv({ generateIds = false } = {}) {
  const generated = generateIds ? generateIdentity() : {};
  return new WfracClient({
    ip: process.env.WF_IP,
    deviceId: process.env.WF_DEVICE_ID || generated.deviceId,
    operatorId: process.env.WF_OPERATOR_ID || generated.operatorId,
    airconId: process.env.WF_AIRCON_ID || "1",
    port: Number(process.env.WF_PORT || 51443),
    httpsMode: process.env.WF_HTTPS !== "0",
  });
}

async function register(client) {
  const result = await registerOperator({
    ip: client.ip,
    port: client.port,
    httpsMode: client.httpsMode,
    timeoutMs: client.timeoutMs,
    deviceId: client.deviceId,
    operatorId: client.operatorId,
  });

  return {
    registered: {
      ip: client.ip,
      deviceId: result.deviceId,
      operatorId: result.operatorId,
      airconId: result.airconId,
    },
    deviceInfo: result.deviceInfo,
    note: "Store deviceId and operatorId in config/aircos.json or WF_DEVICE_ID/WF_OPERATOR_ID. Run 'unregister' with these values to remove the account again.",
  };
}

async function main() {
  const cmd = process.argv[2] || "status";
  const client = buildClientFromEnv({ generateIds: cmd === "register" });
  let result;

  if (cmd === "status") {
    const { raw, status } = await client.getStatus();
    result = {
      parsed: status.toJSON(),
      meta: {
        result: raw.result,
        firmType: raw.contents?.firmType,
        wirelessFirmVer: raw.contents?.wireless?.firmVer,
        mcuFirmVer: raw.contents?.mcu?.firmVer,
        updatedBy: raw.contents?.updatedBy,
        expires: raw.contents?.expires,
        remoteList: raw.contents?.remoteList,
      },
    };
  } else if (cmd === "on") {
    result = await client.update((status) => status.setPower(true));
  } else if (cmd === "off") {
    result = await client.update((status) => status.setPower(false));
  } else if (cmd === "temp") {
    result = await client.update((status) => status.setTargetTemp(process.argv[3]).setPower(true));
  } else if (cmd === "mode") {
    result = await client.update((status) => status.setMode(process.argv[3]));
  } else if (cmd === "airflow") {
    result = await client.update((status) => status.setAirFlow(process.argv[3]));
  } else if (cmd === "3dauto" || cmd === "entrust") {
    result = await client.setEntrust(process.argv[3]);
  } else if (cmd === "register") {
    result = await register(client);
  } else if (cmd === "unregister") {
    result = await client.deleteAccount();
  } else if (cmd === "info") {
    result = await client.getDeviceInfo();
  } else {
    throw new Error(`Unknown command: ${cmd}`);
  }

  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message || err);
    process.exit(1);
  });
}

module.exports = require("./src/wfrac");
