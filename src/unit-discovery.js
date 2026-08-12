"use strict";

const crypto = require("node:crypto");
const net = require("node:net");
const os = require("node:os");
const Bonjour = require("bonjour-service");

const BEAVER_SERVICE_TYPE = "beaver";
const DEFAULT_SCAN_TIMEOUT_MS = 1800;

function interfaceAddresses(interfaces = [], networkInterfaces = os.networkInterfaces()) {
  const requested = Array.isArray(interfaces) ? interfaces : [];
  const entries = requested.length > 0 ? requested : Object.keys(networkInterfaces);
  const addresses = [];

  for (const entry of entries) {
    const candidates = net.isIPv4(entry)
      ? Object.values(networkInterfaces).flat().filter((address) => address?.address === entry)
      : networkInterfaces[entry];

    let found = false;
    for (const address of candidates || []) {
      const ipv4 = address.family === "IPv4" || address.family === 4;
      if (ipv4 && !address.internal) {
        addresses.push(address.address);
        found = true;
      }
    }
    if (requested.length > 0 && !found) {
      throw new Error(`mDNS interface or IPv4 address is not available: ${entry}`);
    }
  }

  const unique = [...new Set(addresses)];
  if (unique.length === 0) {
    throw new Error("No non-loopback IPv4 interface is available for WF-RAC discovery");
  }
  return unique;
}

function serviceAddresses(service) {
  const candidates = [
    ...(Array.isArray(service?.addresses) ? service.addresses : []),
    service?.host,
    service?.referer?.address,
  ];
  return [...new Set(candidates.filter((address) => net.isIPv4(address)))];
}

function compareIpv4(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 4; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function identityForService(service) {
  const identity = String(
    service?.fqdn || `${service?.name || service?.host || "unknown"}._${BEAVER_SERVICE_TYPE}._tcp.local`
  ).trim().replace(/\.$/, "").toLowerCase();
  return crypto.createHash("sha256").update(identity).digest("hex");
}

function normalizeServices(services) {
  const units = new Map();

  for (const service of services) {
    const port = Number(service?.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;

    const discoveryId = identityForService(service);

    for (const ip of serviceAddresses(service)) {
      const unit = {
        name: "Mitsubishi WF-RAC",
        discoveryId,
        ip,
        port,
      };
      units.set(discoveryId, unit);
    }
  }

  return [...units.values()].sort((left, right) => {
    const byAddress = compareIpv4(left.ip, right.ip);
    return byAddress || left.port - right.port || left.name.localeCompare(right.name);
  });
}

async function discoverBeaverUnits(
  { interfaces = [], timeoutMs = DEFAULT_SCAN_TIMEOUT_MS } = {},
  {
    createBonjour = (options, onError) => new Bonjour(options, onError),
    getNetworkInterfaces = os.networkInterfaces,
    wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {}
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("Invalid mDNS scan timeout");

  const addresses = interfaceAddresses(interfaces, getNetworkInterfaces());
  // Bind to the wildcard address so Linux delivers multicast replies to the
  // socket. `interface` still controls group membership and the outgoing query.
  const browseOptions = addresses.map((address) => ({ bind: "0.0.0.0", interface: address }));
  const found = [];
  const instances = [];

  try {
    for (const options of browseOptions) {
      const bonjour = createBonjour(options, (err) => {
        console.warn(`WF-RAC mDNS browser error: ${err.message || err}`);
      });
      const browser = bonjour.find({ type: BEAVER_SERVICE_TYPE, protocol: "tcp" }, (service) => {
        found.push(service);
      });
      instances.push({ bonjour, browser });
    }

    await wait(timeoutMs);
    for (const { browser } of instances) {
      if (Array.isArray(browser.services)) found.push(...browser.services);
    }
    return normalizeServices(found);
  } finally {
    for (const { bonjour, browser } of instances) {
      browser.stop();
      bonjour.destroy();
    }
  }
}

function createUnitDiscoverer(options, dependencies) {
  let activeScan = null;
  return function discoverUnits() {
    if (!activeScan) {
      activeScan = discoverBeaverUnits(options, dependencies).finally(() => {
        activeScan = null;
      });
    }
    return activeScan;
  };
}

module.exports = {
  BEAVER_SERVICE_TYPE,
  createUnitDiscoverer,
  discoverBeaverUnits,
  interfaceAddresses,
  normalizeServices,
};
