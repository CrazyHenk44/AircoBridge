"use strict";

const os = require("node:os");
const net = require("node:net");
const ciao = require("@homebridge/ciao");

const SERVICE_TYPE = "aircobridge";

function listAdvertisableInterfaces(networkInterfaces = os.networkInterfaces()) {
  return Object.entries(networkInterfaces)
    .filter(([, addresses]) => addresses?.some((address) => {
      const ipv4 = address.family === "IPv4" || address.family === 4;
      return ipv4 && !address.internal;
    }))
    .map(([name]) => name);
}

function validateConfiguredInterfaces(interfaces, networkInterfaces) {
  for (const entry of interfaces) {
    const addresses = net.isIP(entry)
      ? Object.values(networkInterfaces).flat().filter((address) => address?.address === entry)
      : networkInterfaces[entry];
    const hasUsableIpv4 = addresses?.some((address) => {
      const ipv4 = address.family === "IPv4" || address.family === 4;
      return ipv4 && !address.internal;
    });
    if (!hasUsableIpv4) {
      throw new Error(`mDNS interface or IPv4 address is not available: ${entry}`);
    }
  }
}

async function startDiscovery(
  { bridgeId, port, version, interfaces = [] },
  { getResponder = ciao.getResponder, getNetworkInterfaces = os.networkInterfaces } = {}
) {
  if (!bridgeId) throw new Error("bridgeId is required for discovery");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("A valid discovery port is required");
  }

  // Pass interface names explicitly. In Docker host mode, `ip link` can call a
  // physical interface `eth0@if7` while Node calls it `eth0`. Ciao's automatic
  // detection then drops it, so use Node's names for the UDP sockets instead.
  const networkInterfaces = getNetworkInterfaces();
  if (interfaces.length > 0) validateConfiguredInterfaces(interfaces, networkInterfaces);
  const responderInterfaces = interfaces.length > 0
    ? [...interfaces]
    : listAdvertisableInterfaces(networkInterfaces);
  if (responderInterfaces.length === 0) {
    throw new Error("No non-loopback IPv4 interface is available for mDNS discovery");
  }
  const responder = getResponder({
    interface: responderInterfaces,
    excludeIpv6: true,
  });
  const shortId = bridgeId.replace(/-/g, "").slice(0, 8);
  const serviceOptions = {
    name: `AircoBridge ${shortId}`,
    hostname: `aircobridge-${shortId}`,
    type: SERVICE_TYPE,
    port,
    disabledIpv6: true,
    txt: {
      id: bridgeId,
      product: SERVICE_TYPE,
      api: "1",
      version: String(version),
      scheme: "http",
    },
  };
  serviceOptions.restrictedAddresses = responderInterfaces;

  const service = responder.createService(serviceOptions);
  service.on("name-change", (name) => {
    console.warn(`mDNS service name changed to ${name} after a network name conflict`);
  });
  service.on("hostname-change", (hostname) => {
    console.warn(`mDNS hostname changed to ${hostname} after a network name conflict`);
  });

  try {
    await service.advertise();
  } catch (err) {
    await responder.shutdown().catch(() => {});
    throw err;
  }

  let stopped = false;
  return {
    serviceName: serviceOptions.name,
    interfaces: responderInterfaces,
    async stop() {
      if (stopped) return;
      stopped = true;
      await responder.shutdown();
    },
  };
}

module.exports = {
  SERVICE_TYPE,
  listAdvertisableInterfaces,
  startDiscovery,
  validateConfiguredInterfaces,
};
