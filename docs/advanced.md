# Advanced usage

Everything beyond the Docker Compose quick start: running without Docker, configuration
details, the CLI and protocol debugging.

## Running without Docker

Install Node.js 24 LTS and npm, then use a config file:

```sh
cp config/aircos.example.json config/aircos.json
npm ci
npm start
```

Or configure a single unit through environment variables:

```sh
WF_IP=192.168.1.100 \
WF_DEVICE_ID=... \
WF_OPERATOR_ID=... \
npm start
```

Then open `http://localhost:3000`.

## Configuration

The service looks for configuration in this order:

1. `AIRCO_CONFIG_JSON` — inline JSON in an environment variable.
2. `AIRCO_CONFIG_FILE` — path to a config file.
3. `config/aircos.json`
4. `WF_IP`, `WF_DEVICE_ID` and `WF_OPERATOR_ID` (single unit).

The setup wizard in the web UI appends units to the config file automatically. To
configure a unit by hand instead, add an entry to the `aircos` array:

```json
{
  "server": { "host": "0.0.0.0", "port": 3000 },
  "aircos": [
    {
      "id": "living-room",
      "name": "Living room",
      "ip": "192.168.1.100",
      "port": 51443,
      "deviceId": "airco-bridge-3f9c21ab54de",
      "operatorId": "1f0c9e5a-7d42-4b8e-9a63-58f2d1c0b7a4",
      "airconId": "a1b2c3d4e5f6",
      "httpsMode": true,
      "pollIntervalMs": 30000,
      "timeoutMs": 10000
    }
  ]
}
```

Multiple units can run in one service. Power history and consumption are tracked
automatically from the polled status and stored in `data/airco-history.json` (override
with `AIRCO_HISTORY_FILE`).

For Docker Compose, the host HTTP port is set through `.env`:

```sh
AIRCO_HTTP_PORT=3000
```

Compose uses `ghcr.io/crazyhenk44/aircobridge:latest` by default. To build and run the
current source tree instead, use `make up-local`. Set `AIRCO_IMAGE` in `.env` to pin a
specific published tag.

## Standalone Docker build

Without Compose:

```sh
docker build -t airco .
docker run --rm \
  -p 127.0.0.1:3000:3000 \
  -v "$PWD/config:/app/config" \
  -v "$PWD/data:/app/data" \
  airco
```

The container expects `/app/config/aircos.json` by default.

## CLI

`wfrac-lib.js` is a small CLI wrapper around the protocol library, configured entirely
through `WF_*` environment variables (`WF_IP`, `WF_DEVICE_ID`, `WF_OPERATOR_ID`, and
optionally `WF_AIRCON_ID`, `WF_PORT`, `WF_HTTPS`):

```sh
node wfrac-lib.js status
node wfrac-lib.js on
node wfrac-lib.js off
node wfrac-lib.js temp 21.5
node wfrac-lib.js mode cool
node wfrac-lib.js airflow auto
node wfrac-lib.js 3dauto on
node wfrac-lib.js info        # getDeviceInfo: airconId / MAC of the module
node wfrac-lib.js register    # register a new operator on the unit (see README)
node wfrac-lib.js unregister  # remove the registered operator again
```

`register` only needs `WF_IP`; it generates a `deviceId` and `operatorId` if they are
not set and prints the values to store in your configuration. All other commands need
`WF_IP`, `WF_DEVICE_ID` and `WF_OPERATOR_ID`.

## Operator accounts

The module holds up to four operator accounts. Registration fails with a clear message
when they are all taken. Unfortunately there is no known Beaver command that returns
the list of registered accounts — the `remoteList` field in the `status` output looks
like one, but in practice it does not include all registered accounts, so treat it as
a hint at best.

What you can do:

- **Delete a specific account** when you know its IDs:

  ```sh
  WF_IP=<unit-ip> WF_DEVICE_ID=<deviceId> WF_OPERATOR_ID=<operatorId> node wfrac-lib.js unregister
  ```

  A `result` of `0` means the account was removed; `1` means the unit does not know
  that account.
- **Let the bridge clean up after itself**: deleting a unit in the web UI (or via
  `DELETE /api/aircos/:id`) automatically removes the account from the unit when the
  bridge registered it itself — see `docs/api.md`.
- **Accounts you did not create** (old phones, app reinstalls): remove the unit from
  the Smart M-Air app installation that registered it, so its slot is freed.

## Reusing an existing identity

Instead of registering a new operator (README step 2), you can reuse an identity that
is already paired with the unit — useful when all four operator slots are taken:

- Capture the Smart M-Air app's local traffic to
  `https://<unit-ip>:51443/beaver/command/...`; every request body contains `deviceId`
  and `operatorId`.
- Or copy the values from another WF-RAC integration you already use, such as the
  [Home Assistant WF-RAC integration](https://github.com/jeatheak/Mitsubishi-WF-RAC-Integration).

## Protocol debugging

For protocol research, use the interactive debug script:

```sh
npm run protocol-debug
```

It reads a baseline status, waits for you to press a button on the unit or remote, reads
the status again and shows which `dataBytes` and `rawBytes` changed. It then asks for a
short description and appends the measurement to `protocol-debug-log.jsonl` (JSON Lines:
one measurement per line, with the previous and current status plus the changed bytes).
The log contains the unit's IP address and raw protocol state. It is ignored by Git by
default; review it carefully before sharing it.

Optionally pick a specific unit and log file:

```sh
node protocol-debug.js --airco living-room --output /tmp/airco-debug.jsonl
```

Raw byte tables are also available through the API with
`GET /api/aircos/:id?raw=1&debug=1`. See `docs/mitsubishi-airco.md` for the protocol
details and known byte layouts.
