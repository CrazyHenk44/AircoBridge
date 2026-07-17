# REST API

The bridge exposes a JSON API on the configured HTTP port (default `3000`). The web
interface uses the same API, so anything the UI can do, your own integration can do too.

There is no authentication; see the security note in the README.

## Reading state

### `GET /api/aircos`

Lists all configured units with their latest polled state. Each `airco` object also
carries `bridgeManagedIdentity` (the bridge created this identity itself) and
`identityShared` (another configured unit uses the same identity); the UI uses these to
predict whether deleting the unit will also remove its account (see `DELETE`).

### `GET /api/aircos/:id`

Full snapshot of one unit: configuration, `online`, `lastUpdate`, `lastError`, the
parsed `status` object and power/usage `history`.

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
history. If the bridge created the identity itself (deviceId with the `airco-bridge-`
prefix) and no other configured unit shares it, the operator account is also removed
from the unit. The response reports what happened:

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
