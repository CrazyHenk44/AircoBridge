"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  WfracStatus,
  crc16ccitt,
  insideTempFromByte,
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

  const parsed = WfracStatus.fromBase64(source.toCommandBase64());
  assert.equal(parsed.operation, true);
  assert.equal(parsed.toJSON().operationModeName, "heat");
  assert.equal(parsed.presetTemp, 22.5);
  assert.equal(parsed.toJSON().airFlowName, "high");
  assert.equal(parsed.entrust, false);
  assert.equal(parsed.isVacantProperty, 1);
  assert.equal(parsed.windDirectionUD, 3);
  assert.equal(parsed.windDirectionLR, 6);
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

test("raw protocol data is only serialized in debug mode", () => {
  const parsed = WfracStatus.fromBase64(new WfracStatus().toCommandBase64());
  assert.equal(Object.hasOwn(parsed.toJSON(), "rawBase64"), false);
  assert.equal(parsed.toJSON({ debug: true }).rawBase64, parsed.rawBase64);
});
