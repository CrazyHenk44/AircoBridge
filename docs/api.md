# REST API

The bridge exposes a JSON API on the configured HTTP port (default `3000`). The web
interface uses the same API, so anything the UI can do, your own integration can do too.

There is no authentication; see the security note in the README.

## Capability detection

### `GET /api/info`

Returns bridge and API metadata for integrations that may be newer than the server:

```json
{
  "name": "AircoBridge",
  "bridgeVersion": "1.2.0",
  "bridgeId": "71bc0a85-836d-4ed7-94bb-8ff12193f378",
  "apiVersion": 1,
  "features": {
    "discovery": true,
    "presets": true,
    "globalPresets": true
  }
}
```

`bridgeId` is generated once and remains stable when the host address changes. LAN
integrations use it to match the HTTP API to the `_aircobridge._tcp.local` mDNS-SD
service. It is an installation identifier, not an air-conditioner credential.

Clients should detect optional functionality through `features`, not by comparing
version strings. A `404` from this endpoint identifies a legacy server; clients can
continue using the existing endpoints while hiding unsupported optional features.

## Reading state

### `GET /api/aircos`

Lists all configured units with their latest polled state. Each `airco` object also
carries `bridgeManagedIdentity` (the bridge created this identity itself) and
`identityShared` (another configured unit uses the same identity); the UI uses these to
predict whether deleting the unit will also remove its account (see `DELETE`). Every
item also has a `presets` array containing that unit's named presets.

### `GET /api/aircos/:id`

Full snapshot of one unit: configuration, `online`, `lastUpdate`, `lastError`, the
parsed `status` object, power/usage `history` and its current `presets` array. Newer
clients can use the presence of the `presets` property as per-unit feature detection:
an empty array means presets are supported but none have been saved. Legacy servers
omit the property entirely.

Relevant `history` fields include the approximated current power in `currentWatts`,
calendar totals in `dayTotalKwh`, `monthTotalKwh` and `monthly`, and the persistent,
per-unit cumulative meter value in `totalKwh`.

Query parameters:

- `?raw=1` — include the raw Beaver API response (firmware versions, `airconStat`, …).
- `?debug=1` — include raw byte tables for parser work.

Relevant `status` fields:

| Field | Meaning |
| --- | --- |
| `power` | `"on"` or `"off"` |
| `presetTemp` | target temperature in °C |
| `operationModeName` | `auto`, `cool`, `heat`, `fan`, `dry` |
| `airFlowName` | `auto`, `lowest`, `low`, `high`, `highest` |
| `windDirectionUD` | vertical vane, `0..4` (`0` = auto) |
| `windDirectionLR` | horizontal vane, `0..7` (`0` = auto) |
| `entrust` | 3D auto on/off |
| `indoorTemp` / `outdoorTemp` | measured temperatures in °C |
| `electric` | current power value from the unit |
| `errorCode` | `"00"` when healthy, otherwise `Mxx`/`Ex` fault code |

### `POST /api/aircos/:id/refresh`

Forces an immediate poll and returns the fresh snapshot.

## Writing state

All write endpoints take a JSON body, apply a read-modify-write cycle against the unit
and return the updated snapshot. Writes to the same unit are queued, so concurrent
requests will not conflict.

### `POST /api/aircos/:id/power`

```json
{ "power": "on" }
```

`power`, `operation` or `value`; accepts `true`/`false`, `"on"`/`"off"`, `1`/`0`.

### `POST /api/aircos/:id/temperature`

```json
{ "temperature": 21.5 }
```

Target temperature in 0.5 °C steps (`temperature`, `presetTemp` or `value`).

### `POST /api/aircos/:id/mode`

```json
{ "mode": "cool" }
```

One of `auto`, `cool`, `heat`, `fan`, `dry` (`mode`, `operationMode` or `value`).

### `POST /api/aircos/:id/airflow`

```json
{ "airflow": "auto" }
```

One of `auto`, `lowest`, `low`, `high`, `highest` (`medium` is accepted as an alias for
`low`).

### `POST /api/aircos/:id/vane`

```json
{ "windDirectionUD": 2, "windDirectionLR": 3 }
```

Vertical vane `0..4`, horizontal vane `0..7`; `0` means auto. Either or both keys.

### `POST /api/aircos/:id/entrust`

```json
{ "entrust": true }
```

Toggles 3D auto.

### `POST /api/aircos/:id/vacant` and `POST /api/aircos/:id/vacant-preset`

```json
{ "vacant": true }
```

`vacant` sets the vacant-property flag as-is. `vacant-preset` additionally captures the
current settings when enabling and restores them when disabling.

### `POST /api/aircos/:id/settings`

Combined update; any subset of the fields above in one call:

```json
{
  "power": "on",
  "temperature": 22,
  "mode": "heat",
  "airflow": "low",
  "entrust": false,
  "windDirectionUD": 0,
  "windDirectionLR": 0
}
```

## Presets

Presets belong to individual air conditioners and contain target temperature, mode,
fan speed, both vane positions, 3D auto, the vacant flag and the automatic cool/heat
decision flag. Applying a preset always turns the selected unit on. Presets are
persisted in `data/airco-presets.json`.

### `GET /api/aircos/:id/presets`

Lists the presets saved for one unit.

The same list is included in `GET /api/aircos/:id`, allowing clients that already poll
the unit snapshot to discover support and keep the available choices current without a
separate capability cache.

### `POST /api/aircos/:id/presets`

Captures the unit's latest known settings under a name:

```json
{ "name": "Sleep", "global": false }
```

With `global: true`, the preset is copied to every air conditioner configured at that
moment. Each copy is independent: applying or deleting it still affects only the unit
named in the request. Units added later do not automatically receive previous copies.

### `POST /api/aircos/:id/presets/:presetId/apply`

Applies every setting in the selected preset to that unit in one queued update.

### `DELETE /api/aircos/:id/presets/:presetId`

Deletes the selected preset only from that unit.

## Setup endpoints

These power the setup wizard in the web UI; you can also call them directly. All
take a JSON body with at least `ip` (and optionally `port`, default `51443`).

### `POST /api/setup/probe`

```json
{ "ip": "192.168.1.100" }
```

Checks whether a WF-RAC unit answers on the address and returns its `airconId`,
`macAddress` and `apMode`.

### `POST /api/setup/register`

```json
{ "ip": "192.168.1.100" }
```

Generates a fresh `deviceId`/`operatorId`, registers it on the unit and returns the
identity plus device info. Returns `409` with a clear message when the unit's four
operator slots are all taken.

### `POST /api/setup/test`

```json
{ "ip": "192.168.1.100", "deviceId": "…", "operatorId": "…", "airconId": "…" }
```

Reads the live status with the given credentials and returns `{ "ok": true, "status": … }`.

### `POST /api/setup/unregister`

Same body as `test`; removes the operator account from the unit again.

### `POST /api/aircos`

```json
{ "name": "Living room", "ip": "192.168.1.100", "deviceId": "…", "operatorId": "…", "airconId": "…" }
```

Adds the unit: generates a slug `id` from the name, appends it to the config file,
starts polling and returns the first snapshot with status `201`. Requires a file-based
configuration (not `AIRCO_CONFIG_JSON`).

### `DELETE /api/aircos/:id`

Removes the unit: stops polling, deletes it from the config file and discards its usage
history and presets. If the bridge created the identity itself (deviceId with the
`airco-bridge-` prefix) and no other configured unit shares it, the operator account is
also removed from the unit. The response reports what happened:

```json
{ "removed": "living-room", "accountDeleted": true }
```

`accountDeleted` is `true` (account removed from the unit), `false` (removal was
attempted but failed — clean it up in the Smart M-Air app) or `null` (identity was not
created by the bridge, or still in use by another configured unit).

## Errors

Errors are returned as JSON with an appropriate status code:

```json
{ "error": "Expected boolean-like entrust" }
```

- `400` — invalid body or value.
- `404` — unknown unit id or action.
- `405` — wrong HTTP method.
- `500` — communication with the unit failed (message in `error`).
