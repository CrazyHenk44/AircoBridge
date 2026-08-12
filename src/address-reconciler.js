"use strict";

const { updateAircosInFile } = require("./config");

const DEFAULT_MIN_SCAN_INTERVAL_MS = 10_000;

function createAddressReconciler(
  manager,
  { discoverUnits, configFile = null, minScanIntervalMs = DEFAULT_MIN_SCAN_INTERVAL_MS } = {},
  { now = Date.now, log = console.log } = {}
) {
  if (typeof discoverUnits !== "function") throw new Error("discoverUnits is required");
  let activeScan = null;
  let lastScanStartedAt = -Infinity;

  async function runScan() {
    const units = await discoverUnits();
    const configs = manager.configs();
    const changes = [];
    const fileUpdates = [];
    const assignments = [];
    const assignedConfigIds = new Set();
    const assignedDiscoveryIds = new Set();

    for (const unit of units) {
      let matches = configs.filter((config) => config.discoveryId === unit.discoveryId);
      if (matches.length === 0) {
        matches = configs.filter((config) => (
          !config.discoveryId
            && !assignedConfigIds.has(config.id)
            && config.ip === unit.ip
            && Number(config.port) === unit.port
        ));
      }

      for (const config of matches) {
        assignments.push({ config, unit });
        assignedConfigIds.add(config.id);
        assignedDiscoveryIds.add(unit.discoveryId);
      }
    }

    const unlinkedConfigs = configs.filter((config) => !config.discoveryId && !assignedConfigIds.has(config.id));
    const unassignedUnits = units.filter((unit) => !assignedDiscoveryIds.has(unit.discoveryId));
    if (unlinkedConfigs.length === 1 && unassignedUnits.length === 1) {
      assignments.push({ config: unlinkedConfigs[0], unit: unassignedUnits[0] });
    }

    for (const { config, unit } of assignments) {
      const patch = {};
      const learnedIdentity = !config.discoveryId;
      const addressChanged = config.ip !== unit.ip || Number(config.port) !== unit.port;

      if (learnedIdentity) {
        config.discoveryId = unit.discoveryId;
        patch.discoveryId = unit.discoveryId;
      }
      if (addressChanged) {
        patch.ip = unit.ip;
        patch.port = unit.port;
        manager.updateEndpoint(config.id, unit);
      }
      if (Object.keys(patch).length === 0) continue;

      fileUpdates.push({ id: config.id, patch });
      changes.push({
        id: config.id,
        addressChanged,
        learnedIdentity,
        ip: unit.ip,
        port: unit.port,
      });
    }

    try {
      updateAircosInFile(configFile, fileUpdates);
    } catch (err) {
      console.warn(`Could not persist mDNS endpoint updates: ${err.message || err}`);
    }
    for (const change of changes) {
      if (change.addressChanged) {
        log(`mDNS updated ${change.id} endpoint to ${change.ip}:${change.port}`);
      } else if (change.learnedIdentity) {
        log(`mDNS linked ${change.id} to its stable discovery identity`);
      }
    }
    return changes;
  }

  function reconcile({ force = false } = {}) {
    if (activeScan) return activeScan;
    const startedAt = now();
    if (!force && startedAt - lastScanStartedAt < minScanIntervalMs) return Promise.resolve([]);
    lastScanStartedAt = startedAt;
    activeScan = runScan().finally(() => {
      activeScan = null;
    });
    return activeScan;
  }

  async function recover(config) {
    const changes = await reconcile();
    return changes.some((change) => change.id === config.id && change.addressChanged);
  }

  return { reconcile, recover };
}

module.exports = { createAddressReconciler };
