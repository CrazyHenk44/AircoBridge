"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { combineSelfCleanStatus } = require("../src/airco-manager");

test("self-clean status combines the device flag with a managed clean cycle", () => {
  const inactive = combineSelfCleanStatus({ isSelfCleanOperation: false }, null);
  assert.equal(inactive.isSelfCleanOperation, false);
  assert.equal(inactive.selfCleanSource, null);

  const device = combineSelfCleanStatus({ isSelfCleanOperation: true }, null);
  assert.equal(device.isSelfCleanOperation, true);
  assert.equal(device.deviceSelfCleanOperation, true);
  assert.equal(device.selfCleanSource, "device");

  const managed = combineSelfCleanStatus({ isSelfCleanOperation: false }, {
    endsAt: "2026-08-14T08:30:00.000Z",
  });
  assert.equal(managed.isSelfCleanOperation, true);
  assert.equal(managed.managedSelfCleanOperation, true);
  assert.equal(managed.selfCleanSource, "automation");
  assert.equal(managed.selfCleanUntil, "2026-08-14T08:30:00.000Z");
});
