"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const { WfracClient } = require("./wfrac-lib");

const DEFAULT_CONFIG_PATH = path.join(__dirname, "config", "aircos.json");
const DEFAULT_OUTPUT_PATH = path.join(__dirname, "protocol-debug-log.jsonl");

function parseArgs(argv) {
  const options = {
    configPath: DEFAULT_CONFIG_PATH,
    aircoId: null,
    outputPath: DEFAULT_OUTPUT_PATH,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") options.configPath = argv[index + 1];
    else if (arg === "--airco") options.aircoId = argv[index + 1];
    else if (arg === "--output") options.outputPath = argv[index + 1];
    else continue;

    index += 1;
  }

  return options;
}

function loadAircoConfig(configPath, aircoId) {
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw);
  const aircos = Array.isArray(parsed.aircos) ? parsed.aircos : [];

  if (aircos.length === 0) throw new Error(`No air conditioners found in ${configPath}`);
  if (!aircoId) return aircos[0];

  const match = aircos.find((airco) => airco.id === aircoId);
  if (!match) throw new Error(`Unknown air conditioner ID "${aircoId}" in ${configPath}`);
  return match;
}

function toUnsignedBytes(bytes) {
  if (!Array.isArray(bytes)) return [];
  return bytes.map((value) => (value < 0 ? 256 + value : value));
}

function formatByte(value) {
  if (value == null) return "--";
  return `0x${value.toString(16).toUpperCase().padStart(2, "0")} (${value})`;
}

function diffBytes(previous, current) {
  const max = Math.max(previous.length, current.length);
  const diff = [];

  for (let index = 0; index < max; index += 1) {
    const before = previous[index];
    const after = current[index];
    if (before !== after) {
      diff.push({
        index,
        before: before ?? null,
        after: after ?? null,
      });
    }
  }

  return diff;
}

function sampleSummary(status) {
  const parsed = status.toJSON();
  return {
    power: status.operation ? "on" : "off",
    presetTemp: status.presetTemp,
    operationMode: status.operationMode,
    operationModeName: parsed.operationModeName,
    airFlow: status.airFlow,
    airFlowName: parsed.airFlowName,
    windDirectionUD: status.windDirectionUD,
    windDirectionLR: status.windDirectionLR,
    entrust: status.entrust,
    coolHotJudge: status.coolHotJudge,
    modelNo: status.modelNo,
    isVacantProperty: status.isVacantProperty,
    isSelfCleanOperation: status.isSelfCleanOperation,
  };
}

function buildSnapshot(response) {
  const { raw, status } = response;

  return {
    capturedAt: new Date().toISOString(),
    summary: sampleSummary(status),
    rawMeta: {
      result: raw?.result,
      firmType: raw?.contents?.firmType,
      updatedBy: raw?.contents?.updatedBy,
      expires: raw?.contents?.expires,
    },
    rawBase64: status.rawBase64,
    rawBytes: toUnsignedBytes(status.rawBytes),
    dataBytes: toUnsignedBytes(status.dataBytes),
  };
}

function appendLog(outputPath, entry) {
  fs.appendFileSync(outputPath, `${JSON.stringify(entry)}\n`);
}

function printSnapshot(label, snapshot) {
  console.log(`\n${label}`);
  console.log(`time: ${snapshot.capturedAt}`);
  console.log(`mode: ${snapshot.summary.operationModeName}, power: ${snapshot.summary.power}, temp: ${snapshot.summary.presetTemp}`);
  console.log(`airflow: ${snapshot.summary.airFlowName}, ud: ${snapshot.summary.windDirectionUD}, lr: ${snapshot.summary.windDirectionLR}, 3D auto: ${snapshot.summary.entrust ? "on" : "off"}`);
}

function printDiffs(title, diffs) {
  console.log(`\n${title}: ${diffs.length} change(s)`);
  if (diffs.length === 0) {
    console.log("no byte changes");
    return;
  }

  for (const diff of diffs) {
    console.log(`[${diff.index}] ${formatByte(diff.before)} -> ${formatByte(diff.after)}`);
  }
}

function createPrompt() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return {
    ask(question) {
      return new Promise((resolve) => {
        rl.question(question, resolve);
      });
    },
    close() {
      rl.close();
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const aircoConfig = loadAircoConfig(options.configPath, options.aircoId);
  const client = new WfracClient(aircoConfig);
  const prompt = createPrompt();

  console.log(`Air conditioner: ${aircoConfig.name || aircoConfig.id} (${aircoConfig.id})`);
  console.log(`Config: ${options.configPath}`);
  console.log(`Log file: ${options.outputPath}`);

  try {
    let response = await client.getStatus();
    let previous = buildSnapshot(response);

    appendLog(options.outputPath, {
      type: "baseline",
      airco: {
        id: aircoConfig.id,
        name: aircoConfig.name,
        ip: aircoConfig.ip,
      },
      snapshot: previous,
    });

    printSnapshot("Initial status", previous);

    while (true) {
      const command = (await prompt.ask("\nPress a button on the unit or remote, then press Enter here. Type q to stop: ")).trim().toLowerCase();
      if (command === "q" || command === "quit" || command === "exit") break;

      response = await client.getStatus();
      const current = buildSnapshot(response);
      const rawDiff = diffBytes(previous.rawBytes, current.rawBytes);
      const dataDiff = diffBytes(previous.dataBytes, current.dataBytes);

      printSnapshot("New status", current);
      printDiffs("Data bytes", dataDiff);
      printDiffs("Raw bytes", rawDiff);

      const description = (await prompt.ask("Brief description of the action: ")).trim();
      appendLog(options.outputPath, {
        type: "diff",
        airco: {
          id: aircoConfig.id,
          name: aircoConfig.name,
          ip: aircoConfig.ip,
        },
        description,
        previous,
        current,
        diff: {
          rawBytes: rawDiff,
          dataBytes: dataDiff,
        },
      });

      console.log(`Saved to ${options.outputPath}`);
      previous = current;
    }
  } finally {
    prompt.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message || err);
    process.exit(1);
  });
}
