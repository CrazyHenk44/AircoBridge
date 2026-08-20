"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  WfracClient,
  WfracStatus,
  coilTemperatureFromByte,
  crc16ccitt,
  decodeOperationData,
  insideTempFromByte,
  operationDataRequestBase64,
  outsideTempFromByte,
  parseVariableBlocks,
} = require("../src/wfrac");

test("crc16ccitt matches the standard check value", () => {
  assert.equal(crc16ccitt([...Buffer.from("123456789")]), 0x29b1);
});

test("status commands round-trip through the protocol packets", () => {
  const source = new WfracStatus()
    .setPower(true)
    .setMode("heat")
    .setTargetTemp(22.5)
    .setAirFlow("high")
    .setEntrust(false)
    .setVacantProperty(true)
    .setWindDirectionUD(3)
    .setWindDirectionLR(6);
  source.isSelfCleanOperation = true;

  const parsed = WfracStatus.fromBase64(source.toCommandBase64());
  assert.equal(parsed.operation, true);
  assert.equal(parsed.toJSON().operationModeName, "heat");
  assert.equal(parsed.presetTemp, 22.5);
  assert.equal(parsed.toJSON().airFlowName, "high");
  assert.equal(parsed.entrust, false);
  assert.equal(parsed.isVacantProperty, 1);
  assert.equal(parsed.windDirectionUD, 3);
  assert.equal(parsed.windDirectionLR, 6);
  assert.equal(parsed.isSelfCleanOperation, true);
});

test("compressor running is read directly from receive state byte 9", () => {
  const bytes = [...Buffer.from(new WfracStatus().toCommandBase64(), "base64")];
  const receiveStart = bytes[18] * 4 + 21;
  bytes[receiveStart + 9] |= 0x02;
  const receiveCrcIndex = bytes.length - 2;
  const crc = crc16ccitt(bytes.slice(receiveStart, receiveCrcIndex));
  bytes[receiveCrcIndex] = crc & 0xff;
  bytes[receiveCrcIndex + 1] = crc >> 8;

  const parsed = WfracStatus.fromBase64(Buffer.from(bytes).toString("base64"));
  assert.equal(parsed.compressorRunning, true);
  assert.equal(parsed.toJSON().compressorRunning, true);
});

test("variable status blocks are decoded", () => {
  const data = Array(19).fill(0).concat([
    128, 32, 100, 0,
    128, 16, 120, 0,
    148, 16, 4, 0,
  ]);

  const parsed = parseVariableBlocks(data);
  assert.equal(parsed.indoorTemp, insideTempFromByte(100));
  assert.equal(parsed.outdoorTemp, outsideTempFromByte(120));
  assert.equal(parsed.electric, 1);
  assert.equal(parsed.variableBlocks.length, 3);
});

test("operation-data requests use an empty command state and at most three codes", () => {
  const bytes = [...Buffer.from(operationDataRequestBase64([0x90, 0x11, 0x85]), "base64")];
  assert.deepEqual(bytes.slice(0, 18), [0, 0, 0, 0, 0, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(bytes.slice(18, 31), [3, 0x90, 0xff, 0xff, 0xff, 0x11, 0xff, 0xff, 0xff, 0x85, 0xff, 0xff, 0xff]);
  assert.equal(crc16ccitt(bytes.slice(0, 31)), bytes[31] | (bytes[32] << 8));

  const receiveStart = 33;
  assert.deepEqual(bytes.slice(receiveStart, receiveStart + 18), [0, 0, 0, 0, 0, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(bytes.slice(receiveStart + 18, receiveStart + 23), [1, 0xff, 0xff, 0xff, 0xff]);
  assert.throws(() => operationDataRequestBase64([1, 2, 3, 4]), /1 to 3 codes/);
});

test("operation-data segments retain their raw bytes and decode live system values", () => {
  const blocks = [
    [0x90, 0x10, 0x06, 0xff],
    [0x11, 0x12, 0x01, 0xff],
    [0x85, 0x10, 0x28, 0xff],
    [0x13, 0x10, 0x5b, 0x00],
    [0x81, 0x20, 0x3d, 0xff],
    [0x87, 0x10, 0x3d, 0xff],
  ].map((bytes, index) => ({ offset: 19 + index * 4, bytes }));
  const decoded = decodeOperationData(blocks);

  assert.ok(Math.abs(decoded.operatingCurrentAmps - 1.6470588235) < 1e-9);
  assert.ok(Math.abs(decoded.powerWatts - 378.8235294) < 1e-7);
  assert.ok(Math.abs(decoded.powerUncertaintyWatts - 31.56862745) < 1e-8);
  assert.equal(decoded.powerScope, "outdoor-unit");
  assert.equal(decoded.includesIndoorFan, false);
  assert.equal(decoded.powerFactorAdjusted, false);
  assert.ok(Math.abs(decoded.compressorFrequencyHz - 51.3) < 1e-9);
  assert.equal(decoded.dischargeTemperatureC, 52);
  assert.equal(decoded.eevPulses, 91);
  assert.ok(Math.abs(decoded.indoorCoilR1C - 11.6698362) < 1e-6);
  assert.equal(decoded.indoorCoilR1C, decoded.indoorCoilR3C);
  assert.deepEqual(decoded.rawSegments[0].bytes, [0x90, 0x10, 0x06, 0xff]);
  assert.deepEqual(decoded.rawSegments[0].hex, ["0x90", "0x10", "0x06", "0xff"]);
  assert.ok(Math.abs(coilTemperatureFromByte(61) - 11.6698362) < 1e-6);
});

test("operation-data polling falls back to ordinary status when the probe is unavailable", async () => {
  const client = new WfracClient({ ip: "127.0.0.1", deviceId: "device", operatorId: "operator" });
  client.requestOperationData = async () => { throw new Error("probe unavailable"); };
  client.getStatus = async () => ({ raw: { result: 0 }, status: new WfracStatus() });

  const result = await client.getStatusWithOperationData();
  assert.equal(result.status.operationData.powerWatts, null);
  assert.equal(result.status.operationData.rawSegments.length, 0);
  assert.equal(result.status.operationDataError, "probe unavailable");
});

test("raw protocol data is only serialized in debug mode", () => {
  const parsed = WfracStatus.fromBase64(new WfracStatus().toCommandBase64());
  assert.equal(Object.hasOwn(parsed.toJSON(), "rawBase64"), false);
  assert.equal(parsed.toJSON({ debug: true }).rawBase64, parsed.rawBase64);
});
