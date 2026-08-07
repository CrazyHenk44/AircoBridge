# Architecture

## Files

- `src/server.js`: HTTP server, REST routing and static file serving (no framework).
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
- Every write is a read-modify-write cycle: read `getAirconStat`, parse, mutate only the
  intended fields, rebuild the packet with CRC and send `setAirconStat`. See
  `docs/mitsubishi-airco.md` for the protocol flow.
- The only runtime dependency is `axios`; the server uses Node's built-in `http`.

## Scope

- This repo manages the bridge, web interface and protocol implementation.
- New integrations should build on the existing HTTP API unless there is a strong reason
  to extend the scope of this bridge.
