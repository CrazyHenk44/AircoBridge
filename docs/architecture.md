# Architecture

## Files

- `src/server.js`: HTTP server, REST routing and static file serving (no framework).
- `src/bridge-identity.js`: creates and loads the persistent discovery identity.
- `src/discovery.js`: advertises the bridge as `_aircobridge._tcp.local` over mDNS-SD.
- `src/unit-discovery.js`: browses for WF-RAC `_beaver._tcp.local` services during
  setup and converts their DNS-SD records to usable IPv4 endpoints.
- `src/address-reconciler.js`: links configured units to hashed DNS-SD identities and
  updates runtime and file endpoints when DHCP changes an address.
- `src/wfrac.js`: the WF-RAC/Beaver protocol implementation (`WfracClient`,
  `WfracStatus`, packet building, CRC, parsing).
- `src/airco-manager.js`: keeps per-unit status, errors and update times;
  polls on an interval.
- `src/config.js`: configuration loading and validation.
- `src/history-store.js`: power/usage history persistence.
- `src/preset-store.js`: persistent, per-unit named control presets.
- `public/`: the web interface (plain HTML/CSS/JS).
- `wfrac-lib.js`: CLI wrapper around `src/wfrac.js` for manual tests, without
  hard-coded secrets.
- `protocol-debug.js`: interactive tool for capturing status-byte changes.
- `Dockerfile`, `compose.yaml`, `Makefile`, `.env.example`: runtime setup.

## Implementation notes

- Writes per unit go through a queue to prevent overlapping commands.
- A startup scan migrates existing endpoint-only configurations when the mapping is
  unambiguous. A failed read or write triggers a rate-limited scan and one retry when
  the resolved endpoint changed.
- Every write is a read-modify-write cycle: read `getAirconStat`, parse, mutate only the
  intended fields, rebuild the packet with CRC and send `setAirconStat`. See
  `docs/mitsubishi-airco.md` for the protocol flow.
- Runtime dependencies are `axios` for WF-RAC requests, `@homebridge/ciao` for bridge
  advertisement and `bonjour-service` for WF-RAC browsing; the server itself uses
  Node's built-in `http`.
- The recommended Docker Compose setup uses host networking because mDNS is link-local
  multicast traffic and does not cross Docker's normal bridge network automatically.

## Scope

- This repo manages the bridge, web interface and protocol implementation.
- New integrations should build on the existing HTTP API unless there is a strong reason
  to extend the scope of this bridge.
