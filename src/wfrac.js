"use strict";

const axios = require("axios");
const http = require("http");
const { INDOOR_TEMP_LIST, OUTDOOR_TEMP_LIST } = require("./temp-lookups");

const DEFAULT_PORT = 51443;
const DEFAULT_USER_AGENT = "smartmair_app[1.4.005]";
const OPERATION_DATA_MIN_REQUEST_INTERVAL_MS = 1000;
const NOMINAL_POWER_VOLTAGE = 230;
const OPERATION_DATA_BATCHES = Object.freeze([
  Object.freeze([0x90, 0x11, 0x85]),
  Object.freeze([0x13, 0x81, 0x87]),
]);
const NO_VARIABLE_DATA_SEGMENT = Object.freeze([0xff, 0xff, 0xff, 0xff]);

const MODES = {
  auto: 0,
  cool: 1,
  heat: 2,
  fan: 3,
  dry: 4,
};

const MODE_NAMES = Object.fromEntries(Object.entries(MODES).map(([name, value]) => [value, name]));
const MODE_LABELS = {
  0: "Auto",
  1: "Cool",
  2: "Heat",
  3: "Fan",
  4: "Dry",
};

const AIRFLOW = {
  auto: 0,
  lowest: 1,
  low: 2,
  high: 3,
  highest: 4,
};

const AIRFLOW_ALIASES = {
  ...AIRFLOW,
  medium: AIRFLOW.low,
};

const AIRFLOW_NAMES = Object.fromEntries(Object.entries(AIRFLOW).map(([name, value]) => [value, name]));
const AIRFLOW_LABELS = {
  0: "Auto",
  1: "Lowest",
  2: "Low",
  3: "High",
  4: "Highest",
};

const WIND_DIRECTION_UD_LABELS = {
  0: "Up/down auto",
  1: "Highest",
  2: "Middle",
  3: "Normal",
  4: "Lowest",
};

const WIND_DIRECTION_LR_LABELS = {
  0: "Left/right auto",
  1: "Left / left",
  2: "Left / middle",
  3: "Middle / middle",
  4: "Middle / right",
  5: "Right / right",
  6: "Left / right",
  7: "Right / left",
};

function toSignedBytes(buffer) {
  return [...buffer].map((b) => (b > 127 ? b - 256 : b));
}

function toUnsignedBuffer(arr) {
  return Buffer.from(arr.map((b) => (b < 0 ? 256 + b : b)));
}

function findMatch(value, values, offset = 0) {
  const idx = values.indexOf(value);
  return idx < 0 ? -1 : idx + offset;
}

function unsignedByte(value) {
  return value < 0 ? 256 + value : value;
}

function byteTable(bytes) {
  if (!Array.isArray(bytes)) return [];
  return bytes.map((signed, index) => {
    const unsigned = unsignedByte(signed);
    return {
      index,
      signed,
      unsigned,
      hex: `0x${unsigned.toString(16).padStart(2, "0")}`,
      bits: unsigned.toString(2).padStart(8, "0"),
    };
  });
}

function insideTempFromByte(value) {
  return INDOOR_TEMP_LIST[unsignedByte(value)] ?? null;
}

function outsideTempFromByte(value) {
  return OUTDOOR_TEMP_LIST[unsignedByte(value)] ?? null;
}

function parseVariableBlocks(dataBytes) {
  const result = {
    indoorTemp: null,
    indoorTempByte: null,
    outdoorTemp: null,
    outdoorTempByte: null,
    electric: 0,
    variableBlocks: [],
  };

  if (!Array.isArray(dataBytes) || dataBytes.length <= 19) return result;

  const copyOfRange = dataBytes.slice(19);
  for (let index = 0; index + 3 < copyOfRange.length; index += 4) {
    const block = copyOfRange.slice(index, index + 4).map(unsignedByte);
    result.variableBlocks.push({
      offset: 19 + index,
      bytes: block,
      hex: block.map((value) => `0x${value.toString(16).padStart(2, "0")}`),
    });

    const [b1, b2, b3] = block;
    if (b1 === 128 && b2 === 32) {
      result.indoorTempByte = b3;
      result.indoorTemp = insideTempFromByte(b3);
    } else if (b1 === 128 && b2 === 16) {
      result.outdoorTempByte = b3;
      result.outdoorTemp = outsideTempFromByte(b3);
    } else if (b1 === 148 && b2 === 16) {
      result.electric = (b3 | (block[3] << 8)) * 0.25;
    }
  }

  return result;
}

function candidateDecodes(dataBytes) {
  if (!Array.isArray(dataBytes)) return {};
  const variableData = parseVariableBlocks(dataBytes);

  return {
    indoorTemp: variableData.indoorTemp,
    indoorTempByte: variableData.indoorTempByte,
    outdoorTemp: variableData.outdoorTemp,
    outdoorTempByte: variableData.outdoorTempByte,
    electric: variableData.electric,
    variableBlocks: variableData.variableBlocks,
  };
}

function crc16ccitt(bytes) {
  let crc = 0xffff;

  for (const inputByte of bytes) {
    const b = inputByte < 0 ? 256 + inputByte : inputByte;

    for (let bit = 0; bit < 8; bit++) {
      const inputBit = ((b >> (7 - bit)) & 1) === 1;
      const crcTopBit = ((crc >> 15) & 1) === 1;

      crc = (crc << 1) & 0xffff;

      if (inputBit !== crcTopBit) {
        crc ^= 0x1021;
      }
    }
  }

  return crc & 0xffff;
}

function makePacket(body18Bytes, segments = [NO_VARIABLE_DATA_SEGMENT]) {
  if (!Array.isArray(body18Bytes) || body18Bytes.length !== 18) {
    throw new Error("makePacket expects exactly 18 bytes");
  }
  if (!Array.isArray(segments) || segments.length > 255 || segments.some(
    (segment) => !Array.isArray(segment) || segment.length !== 4
  )) {
    throw new Error("makePacket expects zero or more four-byte segments");
  }

  const packetWithoutCrc = body18Bytes.concat([segments.length], segments.flat());
  const crc = crc16ccitt(packetWithoutCrc);

  return packetWithoutCrc.concat([crc & 0xff, (crc >> 8) & 0xff]);
}

function emptyOperationState() {
  const bytes = Array(18).fill(0);
  bytes[5] = 0xff;
  return bytes;
}

function operationDataRequestBase64(codes) {
  if (!Array.isArray(codes) || codes.length < 1 || codes.length > 3) {
    throw new Error("Operation-data requests must contain 1 to 3 codes");
  }
  if (codes.some((code) => !Number.isInteger(code) || code < 0 || code > 0xff)) {
    throw new Error("Operation-data codes must be bytes");
  }

  const requests = codes.map((code) => [code, 0xff, 0xff, 0xff]);
  const command = makePacket(emptyOperationState(), requests);
  const receive = makePacket(emptyOperationState());
  return toUnsignedBuffer(command.concat(receive)).toString("base64");
}

function coilTemperatureFromByte(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0 || raw > 0xff) return null;

  const resistance = 1912 * (367 / raw - 1);
  if (!Number.isFinite(resistance) || resistance <= 0) return null;
  return 1 / (1 / 298.15 + Math.log(resistance / 5200) / 3900) - 273.15;
}

function rawOperationSegment(block) {
  const bytes = block.bytes.map(unsignedByte);
  const [code, selector, op2, op3] = bytes;
  return {
    code,
    selector,
    op2,
    op3,
    bytes,
    hex: bytes.map((value) => `0x${value.toString(16).padStart(2, "0")}`),
  };
}

function decodeOperationData(variableBlocks) {
  const requestedCodes = new Set(OPERATION_DATA_BATCHES.flat());
  const rawSegments = (Array.isArray(variableBlocks) ? variableBlocks : [])
    .filter((block) => Array.isArray(block?.bytes) && requestedCodes.has(unsignedByte(block.bytes[0])))
    .map(rawOperationSegment);
  const byCode = new Map(rawSegments.map((segment) => [segment.code, segment]));
  const current = byCode.get(0x90);
  const frequency = byCode.get(0x11);
  const discharge = byCode.get(0x85);
  const eev = byCode.get(0x13);
  const coilR1 = byCode.get(0x81);
  const coilR3 = byCode.get(0x87);
  const operatingCurrentAmps = current && current.op2 !== 0xff ? current.op2 * 14 / 51 : null;
  const powerStepWatts = 14 / 51 * NOMINAL_POWER_VOLTAGE;

  return {
    operatingCurrentAmps,
    powerWatts: operatingCurrentAmps == null ? null : operatingCurrentAmps * NOMINAL_POWER_VOLTAGE,
    powerVoltage: NOMINAL_POWER_VOLTAGE,
    powerStepWatts,
    powerUncertaintyWatts: powerStepWatts / 2,
    powerScope: "outdoor-unit",
    includesIndoorFan: false,
    powerFactorAdjusted: false,
    compressorFrequencyHz: frequency && frequency.selector !== 0xff && frequency.op2 !== 0xff
      ? (frequency.selector - 0x10) * 25.6 + frequency.op2 * 0.1
      : null,
    dischargeTemperatureC: discharge && discharge.op2 !== 0xff ? discharge.op2 / 2 + 32 : null,
    eevPulses: eev && eev.op2 !== 0xff ? eev.op2 : null,
    indoorCoilR1C: coilR1 && coilR1.op2 !== 0xff ? coilTemperatureFromByte(coilR1.op2) : null,
    indoorCoilR3C: coilR3 && coilR3.op2 !== 0xff ? coilTemperatureFromByte(coilR3.op2) : null,
    rawSegments,
  };
}

function normalizeChoice(value, choices, field) {
  if (typeof value === "number") {
    if (!Object.values(choices).includes(value)) throw new Error(`Unknown ${field}: ${value}`);
    return value;
  }

  const key = String(value || "").trim().toLowerCase();
  if (!(key in choices)) throw new Error(`Unknown ${field}: ${value}`);
  return choices[key];
}

class WfracStatus {
  constructor() {
    this.rawBase64 = null;
    this.rawBytes = null;
    this.dataBytes = null;

    this.operation = false;
    this.presetTemp = 21.0;
    this.operationMode = MODES.cool;
    this.airFlow = AIRFLOW.auto;
    this.windDirectionUD = 0;
    this.windDirectionLR = 0;
    this.entrust = true;
    this.coolHotJudge = true;
    this.modelNo = 1;
    this.isVacantProperty = 0;
    this.isSelfCleanOperation = false;
    this.isSelfCleanReset = false;
    this.compressorRunning = false;
    this.indoorTemp = null;
    this.indoorTempByte = null;
    this.outdoorTemp = null;
    this.outdoorTempByte = null;
    this.errorCode = "00";
    this.electric = null;
    this.variableBlocks = [];
    this.operationData = null;
    this.operationDataError = null;
  }

  static fromBase64(base64) {
    const cleaned = String(base64).replace(/\s+/g, "");
    const all = toSignedBytes(Buffer.from(cleaned, "base64"));

    const status = new WfracStatus();
    status.rawBase64 = cleaned;
    status.rawBytes = all;

    const dataStart = all[18] * 4 + 21;
    const data = all.slice(dataStart, all.length - 2);
    status.dataBytes = data;

    if (data.length < 18) {
      throw new Error(`Could not parse airconStat: data block too short (${data.length} bytes)`);
    }

    status.operation = (data[2] & 3) === 1;
    status.presetTemp = data[4] / 2;
    status.operationMode = findMatch(data[2] & 60, [8, 16, 12, 4], 1);
    status.airFlow = findMatch(data[3] & 15, [7, 0, 1, 2, 6]);
    status.windDirectionUD = (data[2] & 192) === 64 ? 0 : findMatch(data[3] & 240, [0, 16, 32, 48], 1);
    status.windDirectionLR = (data[12] & 3) === 1 ? 0 : findMatch(data[11] & 31, [0, 1, 2, 3, 4, 5, 6], 1);
    status.entrust = (data[12] & 12) === 4;
    status.coolHotJudge = (data[8] & 8) <= 0;
    status.compressorRunning = (data[9] & 0x02) === 0x02;
    status.modelNo = findMatch(data[0] & 127, [0, 1, 2]);
    status.isVacantProperty = data[10] & 1;
    status.isSelfCleanOperation = (data[15] & 1) === 1;
    status.isSelfCleanReset = false;
    const code = data[6] & 127;
    if (code === 0) status.errorCode = "00";
    else if ((data[6] & -128) <= 0) status.errorCode = `M${String(code).padStart(2, "0")}`;
    else status.errorCode = `E${code}`;

    const variableData = parseVariableBlocks(data);
    status.indoorTemp = variableData.indoorTemp;
    status.indoorTempByte = variableData.indoorTempByte;
    status.outdoorTemp = variableData.outdoorTemp;
    status.outdoorTempByte = variableData.outdoorTempByte;
    status.electric = variableData.electric;
    status.variableBlocks = variableData.variableBlocks;

    status.normalizeUnknowns();
    return status;
  }

  normalizeUnknowns() {
    if (!Object.values(MODES).includes(this.operationMode)) this.operationMode = MODES.cool;
    if (!Object.values(AIRFLOW).includes(this.airFlow)) this.airFlow = AIRFLOW.auto;
    if (this.windDirectionUD < 0) this.windDirectionUD = 0;
    if (this.windDirectionLR < 0) this.windDirectionLR = 0;
    if (!Number.isFinite(this.presetTemp) || this.presetTemp < 10 || this.presetTemp > 35) this.presetTemp = 21.0;
    if (this.modelNo < 0) this.modelNo = 1;
  }

  setPower(on) {
    this.operation = Boolean(on);
    return this;
  }

  setMode(mode) {
    this.operationMode = normalizeChoice(mode, MODES, "mode");
    this.operation = true;
    return this;
  }

  setTargetTemp(temp) {
    const n = Number(temp);
    if (!Number.isFinite(n)) throw new Error(`Invalid temperature: ${temp}`);
    if (n < 18 || n > 30) throw new Error("Temperature should be between 18 and 30");
    this.presetTemp = Math.round(n * 2) / 2;
    return this;
  }

  setAirFlow(flow) {
    this.airFlow = normalizeChoice(flow, AIRFLOW_ALIASES, "airflow");
    return this;
  }

  setEntrust(enabled) {
    if (enabled === true || enabled === false) {
      this.entrust = enabled;
      return this;
    }

    const value = String(enabled ?? "").trim().toLowerCase();
    if (["on", "true", "1"].includes(value)) {
      this.entrust = true;
      return this;
    }
    if (["off", "false", "0"].includes(value)) {
      this.entrust = false;
      return this;
    }

    throw new Error(`Invalid entrust value: ${enabled}`);
  }

  setVacantProperty(enabled) {
    if (enabled === true || enabled === false) {
      this.isVacantProperty = enabled ? 1 : 0;
      return this;
    }

    const value = String(enabled ?? "").trim().toLowerCase();
    if (["on", "true", "1"].includes(value)) {
      this.isVacantProperty = 1;
      return this;
    }
    if (["off", "false", "0"].includes(value)) {
      this.isVacantProperty = 0;
      return this;
    }

    throw new Error(`Invalid vacant value: ${enabled}`);
  }

  setVacantPreset(enabled) {
    const value = enabled === true || enabled === false
      ? enabled
      : ["on", "true", "1"].includes(String(enabled ?? "").trim().toLowerCase());

    if (value) {
      this.operation = true;
      this.operationMode = MODES.heat;
      this.presetTemp = 10;
      this.coolHotJudge = true;
      this.isVacantProperty = 1;
      return this;
    }

    this.isVacantProperty = 0;
    return this;
  }

  setWindDirectionUD(value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 4) {
      throw new Error("windDirectionUD must be integer 0..4");
    }
    this.windDirectionUD = n;
    return this;
  }

  setWindDirectionLR(value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 7) {
      throw new Error("windDirectionLR must be integer 0..7");
    }
    this.windDirectionLR = n;
    return this;
  }

  commandToBytes() {
    const b = [0, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    b[2] |= this.operation ? 3 : 2;

    if (this.operationMode === MODES.auto) b[2] |= 32;
    else if (this.operationMode === MODES.cool) b[2] |= 40;
    else if (this.operationMode === MODES.heat) b[2] |= 48;
    else if (this.operationMode === MODES.fan) b[2] |= 44;
    else if (this.operationMode === MODES.dry) b[2] |= 36;

    if (this.airFlow === AIRFLOW.auto) b[3] |= 15;
    else if (this.airFlow === AIRFLOW.lowest) b[3] |= 8;
    else if (this.airFlow === AIRFLOW.low) b[3] |= 9;
    else if (this.airFlow === AIRFLOW.high) b[3] |= 10;
    else if (this.airFlow === AIRFLOW.highest) b[3] |= 14;

    if (this.windDirectionUD === 0) {
      b[2] |= 192;
      b[3] |= 128;
    } else if (this.windDirectionUD === 1) {
      b[2] |= 128;
      b[3] |= 128;
    } else if (this.windDirectionUD === 2) {
      b[2] |= 128;
      b[3] |= 144;
    } else if (this.windDirectionUD === 3) {
      b[2] |= 128;
      b[3] |= 160;
    } else if (this.windDirectionUD === 4) {
      b[2] |= 128;
      b[3] |= 176;
    }

    if (this.windDirectionLR === 0) {
      b[12] |= 3;
      b[11] |= 16;
    } else if (this.windDirectionLR >= 1) {
      b[12] |= 2;
      b[11] |= 15 + this.windDirectionLR;
    }

    const temp = this.operationMode !== MODES.dry && this.presetTemp != null ? this.presetTemp : 25.0;

    b[4] |= Math.floor(temp / 0.5) + 128;
    b[12] |= this.entrust ? 12 : 8;

    if (this.modelNo === 1) b[10] |= this.isVacantProperty ? 1 : 0;

    if (this.modelNo === 1 || this.modelNo === 2) {
      b[10] |= this.isSelfCleanReset ? 4 : 0;
      b[10] |= this.isSelfCleanOperation ? 144 : 128;
    }

    return b;
  }

  receiveToBytes() {
    const b = [0, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    if (this.operation) b[2] |= 1;

    if (this.operationMode === MODES.cool) b[2] |= 8;
    else if (this.operationMode === MODES.heat) b[2] |= 16;
    else if (this.operationMode === MODES.fan) b[2] |= 12;
    else if (this.operationMode === MODES.dry) b[2] |= 4;

    if (this.airFlow === AIRFLOW.auto) b[3] |= 7;
    else if (this.airFlow === AIRFLOW.low) b[3] |= 1;
    else if (this.airFlow === AIRFLOW.high) b[3] |= 2;
    else if (this.airFlow === AIRFLOW.highest) b[3] |= 6;

    if (this.windDirectionUD === 0) b[2] |= 64;
    else if (this.windDirectionUD === 2) b[3] |= 16;
    else if (this.windDirectionUD === 3) b[3] |= 32;
    else if (this.windDirectionUD === 4) b[3] |= 48;

    if (this.windDirectionLR === 0) b[12] |= 1;
    else if (this.windDirectionLR >= 1) b[11] |= this.windDirectionLR - 1;

    const temp = this.operationMode !== MODES.dry && this.presetTemp != null ? this.presetTemp : 25.0;

    b[4] |= Math.floor(temp / 0.5);
    if (this.entrust) b[12] |= 4;
    if (!this.coolHotJudge) b[8] |= 8;

    if (this.modelNo === 1) b[0] |= 1;
    else if (this.modelNo === 2) b[0] |= 2;

    if (this.modelNo === 1) b[10] |= this.isVacantProperty ? 1 : 0;
    if (this.modelNo === 1 || this.modelNo === 2) b[15] |= this.isSelfCleanOperation ? 1 : 0;

    return b;
  }

  toCommandBase64() {
    const bytes = makePacket(this.commandToBytes()).concat(makePacket(this.receiveToBytes()));
    return toUnsignedBuffer(bytes).toString("base64");
  }

  toJSON({ debug = false } = {}) {
    const value = {
      operation: this.operation,
      power: this.operation ? "on" : "off",
      presetTemp: this.presetTemp,
      operationMode: this.operationMode,
      operationModeName: MODE_NAMES[this.operationMode] || "unknown",
      operationModeLabel: MODE_LABELS[this.operationMode] || "Unknown",
      airFlow: this.airFlow,
      airFlowName: AIRFLOW_NAMES[this.airFlow] || "unknown",
      airFlowLabel: AIRFLOW_LABELS[this.airFlow] || "Unknown",
      windDirectionUD: this.windDirectionUD,
      windDirectionUDLabel: WIND_DIRECTION_UD_LABELS[this.windDirectionUD] || "Unknown",
      windDirectionLR: this.windDirectionLR,
      windDirectionLRLabel: WIND_DIRECTION_LR_LABELS[this.windDirectionLR] || "Unknown",
      entrust: this.entrust,
      entrustLabel: this.entrust ? "3D auto on" : "3D auto off",
      coolHotJudge: this.coolHotJudge,
      modelNo: this.modelNo,
      isVacantProperty: this.isVacantProperty,
      vacantLabel: this.isVacantProperty ? "Vacant preset on" : "Vacant preset off",
      isSelfCleanOperation: this.isSelfCleanOperation,
      selfCleanOperationLabel: this.isSelfCleanOperation ? "Self-clean active" : "Self-clean off",
      isSelfCleanReset: this.isSelfCleanReset,
      compressorRunning: this.compressorRunning,
      indoorTemp: this.indoorTemp,
      indoorTempByte: this.indoorTempByte,
      outdoorTemp: this.outdoorTemp,
      outdoorTempByte: this.outdoorTempByte,
      errorCode: this.errorCode,
      electric: this.electric,
      electricUnit: "WF-RAC electric",
      operationData: this.operationData,
      operationDataError: this.operationDataError,
    };

    if (debug) {
      value.rawBase64 = this.rawBase64;
      value.rawBytes = this.rawBytes;
      value.dataBytes = this.dataBytes;
      value.rawByteTable = byteTable(this.rawBytes);
      value.dataByteTable = byteTable(this.dataBytes);
      value.unparsedDataBytes = this.dataBytes ? byteTable(this.dataBytes.slice(18)) : [];
      value.variableBlocks = this.variableBlocks;
      value.candidateDecodes = candidateDecodes(this.dataBytes);
    }

    return value;
  }
}

class WfracClient {
  constructor({
    ip,
    port = DEFAULT_PORT,
    deviceId,
    operatorId,
    airconId = "1",
    httpsMode = false,
    userAgent = DEFAULT_USER_AGENT,
    timeoutMs = 10000,
  }) {
    if (!ip) throw new Error("ip is required");
    if (!deviceId) throw new Error("deviceId is required");
    if (!operatorId) throw new Error("operatorId is required");

    this.ip = ip;
    this.port = port;
    this.deviceId = deviceId;
    this.operatorId = operatorId;
    this.airconId = String(airconId);
    this.httpsMode = httpsMode;
    this.userAgent = userAgent;
    this.timeoutMs = timeoutMs;

    this.http = axios.create({
      timeout: this.timeoutMs,
      httpAgent: new http.Agent(),
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": this.userAgent,
        "Accept": "*/*",
      },
    });
  }

  url(command) {
    const scheme = this.httpsMode ? "https" : "http";
    return `${scheme}://${this.ip}:${this.port}/beaver/command/${command}`;
  }

  basePayload(command, contents = undefined) {
    const payload = {
      apiVer: "1.0",
      command,
      deviceId: this.deviceId,
      operatorId: this.operatorId,
      timestamp: Math.floor(Date.now() / 1000),
    };

    if (contents !== undefined) payload.contents = contents;
    return payload;
  }

  async call(command, contents = undefined) {
    const response = await this.http.post(this.url(command), JSON.stringify(this.basePayload(command, contents)));
    return response.data;
  }

  async getRaw() {
    return this.call("getAirconStat", { airconId: this.airconId });
  }

  async getDeviceInfo() {
    const raw = await this.call("getDeviceInfo");
    return raw?.contents || raw;
  }

  async registerAccount(timezone) {
    return this.call("updateAccountInfo", {
      accountId: this.operatorId,
      airconId: this.airconId,
      remote: 0,
      timezone,
    });
  }

  async deleteAccount() {
    return this.call("deleteAccountInfo", {
      accountId: this.operatorId,
      airconId: this.airconId,
    });
  }

  async getStatus() {
    const raw = await this.getRaw();
    const airconStat = raw?.contents?.airconStat || raw?.airconStat;
    if (!airconStat) throw new Error(`No airconStat in response: ${JSON.stringify(raw)}`);
    return { raw, status: WfracStatus.fromBase64(airconStat) };
  }

  async requestOperationData(codes) {
    const raw = await this.call("setAirconStat", {
      airconId: this.airconId,
      airconStat: operationDataRequestBase64(codes),
    });
    const airconStat = raw?.contents?.airconStat || raw?.airconStat;
    if (!airconStat) throw new Error(`No airconStat in operation-data response: ${JSON.stringify(raw)}`);
    return { raw, status: WfracStatus.fromBase64(airconStat) };
  }

  async getStatusWithOperationData() {
    let latest = null;
    let operationDataError = null;
    const operationBlocks = [];
    let previousRequestStartedAt = null;

    for (const codes of OPERATION_DATA_BATCHES) {
      try {
        if (previousRequestStartedAt != null) {
          const waitMs = OPERATION_DATA_MIN_REQUEST_INTERVAL_MS - (Date.now() - previousRequestStartedAt);
          if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
        previousRequestStartedAt = Date.now();
        latest = await this.requestOperationData(codes);
        const requested = new Set(codes);
        operationBlocks.push(...latest.status.variableBlocks.filter(
          (block) => requested.has(unsignedByte(block.bytes?.[0]))
        ));
      } catch (error) {
        operationDataError = error;
        break;
      }
    }

    if (!latest) latest = await this.getStatus();
    latest.status.operationData = decodeOperationData(operationBlocks);
    latest.status.operationDataError = operationDataError?.message || null;
    return latest;
  }

  async setStatus(status) {
    if (!(status instanceof WfracStatus)) throw new Error("setStatus expects WfracStatus");
    return this.call("setAirconStat", {
      airconId: this.airconId,
      airconStat: status.toCommandBase64(),
    });
  }

  async update(mutator) {
    const { status } = await this.getStatus();
    await mutator(status);
    return this.setStatus(status);
  }

  async setEntrust(enabled) {
    return this.update((status) => status.setEntrust(enabled));
  }
}

module.exports = {
  AIRFLOW,
  AIRFLOW_LABELS,
  AIRFLOW_NAMES,
  DEFAULT_PORT,
  DEFAULT_USER_AGENT,
  MODES,
  MODE_LABELS,
  MODE_NAMES,
  WIND_DIRECTION_LR_LABELS,
  WIND_DIRECTION_UD_LABELS,
  WfracClient,
  WfracStatus,
  byteTable,
  candidateDecodes,
  coilTemperatureFromByte,
  crc16ccitt,
  decodeOperationData,
  insideTempFromByte,
  operationDataRequestBase64,
  outsideTempFromByte,
  parseVariableBlocks,
};
