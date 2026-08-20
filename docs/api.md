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
  "bridgeVersion": "1.4.0",
  "bridgeId": "71bc0a85-836d-4ed7-94bb-8ff12193f378",
  "apiVersion": 1,
  "features": {
    "discovery": true,
    "unitDiscovery": true,
    "presets": true,
    "globalPresets": true,
    "automations": true,
    "automationLog": true,
    "manualOverride": true
  }
}
```

`bridgeId` is generated once and remains stable when the host address changes. LAN
integrations use it to match the HTTP API to the `_aircobridge._tcp.local` mDNS-SD
service. It is an installation identifier, not an air-conditioner credential.
`unitDiscovery` reports whether the setup endpoint can browse for
`_beaver._tcp.local` units.

Clients should detect optional functionality through `features`, not by comparing
version strings. A `404` from this endpoint identifies a legacy server; clients can
continue using the existing endpoints while hiding unsupported optional features.

## Reading state

### `GET /api/aircos`

Lists all configured units with their latest polled state. Each `airco` object also
carries `bridgeManagedIdentity` (the bridge created this identity itself) and
`identityShared` (another configured unit uses the same identity); the UI uses these to
predict whether deleting the unit will also remove its account (see `DELETE`). Every
item also has a `presets` array containing that unit's named presets and an
`automationOverride` object (or `null`) describing active manual control.
`airco.addressManaged` is true when the bridge can re-resolve the unit through mDNS
after its IP address changes.

### `GET /api/aircos/:id`

Full snapshot of one unit: configuration, `online`, `lastUpdate`, `lastError`, the
parsed `status` object, power/usage `history` and its current `presets` array. Newer
clients can use the presence of the `presets` property as per-unit feature detection:
an empty array means presets are supported but none have been saved. Legacy servers
omit the property entirely.

`automationOverride` is `null` during normal automation control. While manual control
is active it contains `aircoId`, `startedAt` and `source`. Automation conditions remain
live, but actions targeting that unit are paused until the unit is switched off or the
override is explicitly cleared. Control-state changes received from the physical remote
are recognized on the next unit status poll; changing sensor readings does not start an
override.

Relevant `history` fields include the current run's energy in `currentSession.energyKwh`,
calendar totals in `dayTotalKwh`, `monthTotalKwh` and `monthly`, and the persistent,
per-unit cumulative meter value in `totalKwh`. While the unit is on, `currentWatts`
contains the live outdoor-unit estimate from operation-data code `0x90`; while off it is
`0`. It is no longer inferred from the coarse 0.25-kWh run counter.

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
| `compressorRunning` | compressor-running bit from receive-state byte 9 |
| `indoorTemp` / `outdoorTemp` | measured temperatures in °C |
| `electric` | current-run energy counter from the unit, in 0.25 kWh steps |
| `operationData` | live current/power, compressor frequency, EEV position, discharge and coil temperatures, plus raw segments |
| `operationDataError` | probe error text when basic status succeeded but operation data did not |
| `errorCode` | `"00"` when healthy, otherwise `Mxx`/`Ex` fault code |
| `isSelfCleanOperation` | combined self-clean flag: true for the device function or an automation clean cycle |
| `deviceSelfCleanOperation` | raw self-clean flag reported by the unit |
| `managedSelfCleanOperation` | true while a bridge-managed clean cycle is active |
| `selfCleanSource` / `selfCleanUntil` | source (`device`, `automation`, or both) and optional managed end time |

`status.operationData` contains:

| Field | Meaning |
| --- | --- |
| `operatingCurrentAmps` | outdoor-unit operating current from `0x90` |
| `powerWatts` | `operatingCurrentAmps × 230`, an estimated outdoor-unit value |
| `powerStepWatts` / `powerUncertaintyWatts` | approximately 63 W per raw step and ±32 W quantisation uncertainty |
| `powerScope` | `"outdoor-unit"`; the indoor fan is not included |
| `includesIndoorFan` / `powerFactorAdjusted` | both `false` for the current estimate |
| `compressorFrequencyHz` | inverter frequency; the segment's second byte is its high byte, not an indoor/outdoor selector |
| `dischargeTemperatureC` | compressor discharge-pipe temperature |
| `eevPulses` | raw electronic expansion-valve position; not a percentage |
| `indoorCoilR1C` / `indoorCoilR3C` | two indoor heat-exchanger thermistors |
| `rawSegments` | the original `[code, sel, OP2, OP3]` bytes, retained even for decoded zero values |

The wattage estimate does not include the roughly 10–30 W indoor fan and assumes a
230 V supply without a power-factor correction. Inverter PFC normally keeps the latter
error modest, but it can matter most at low load.

### `POST /api/aircos/:id/refresh`

Forces an immediate poll and returns the fresh snapshot.

## Writing state

All write endpoints take a JSON body, apply a read-modify-write cycle against the unit
and return the updated snapshot. Writes to the same unit are queued, so concurrent
requests will not conflict.

Manual power-on, preset, temperature, mode, airflow and combined-settings commands
start a persistent manual automation override when the unit is on. Integrations issuing
commands as part of their own automation (for example a future Homey Flow action) can
include `"automationOverride": false` to avoid claiming manual control. Power-off always
allows local automation control to resume.

### `POST /api/aircos/:id/automation-override`

```json
{ "active": false }
```

Clears manual control immediately so matching local automation actions can run again.
Sending `true` explicitly starts manual control, but only while the unit is on.

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

Applies every setting in the selected preset to that unit in one queued update and
starts manual control unless `"automationOverride": false` is supplied.

### `DELETE /api/aircos/:id/presets/:presetId`

Deletes the selected preset only from that unit.

## Automations

Automations are directed graphs of condition blocks (`temperature`, `power`, `mode`, `time`),
logic blocks (`and`, `or`) and action blocks (`apply-preset`, `set-power`). The service
evaluates enabled flows in the background and persists them in
`data/airco-automations.json`. Action paths are edge-triggered and each action has an
internal five-minute cooldown to absorb rapidly oscillating conditions.

Disabled flows continue evaluating their connected conditions for a live graphical
preview, but their action blocks are never executed.

Manual control is persisted per air conditioner in the same automation state file.
Matching blocks remain visible as true, while their actions report that they are paused.
Switching the unit off clears manual control automatically; the dashboard also provides
a **Resume automations** action.

A `set-power` action accepts `on`, `off`, or `clean`. The clean action switches the
unit to low fan mode for `durationMinutes` (30 by default) and then turns it off. Its
end time is persisted, so a service restart does not leave the fan running. Starting
a preset or another power action cancels the pending clean shutdown. When the unit's
current mode is `heat` or `fan`, the clean cycle is skipped and the unit switches off
immediately, matching the appliance's SELF CLEAN restrictions. Retriggering a clean
action while a bridge-managed clean cycle is already running leaves that cycle and
its original end time untouched.

### `GET /api/automations`

Lists every graph together with transient `runtime` evaluation state. Runtime state
includes the latest status/message, action trigger times and per-node results; it is
not written to the automation file.

### `POST /api/automations`

Creates a graph. `PUT /api/automations/:id` replaces its editable values and
`DELETE /api/automations/:id` removes it. A minimal payload is:

```json
{
  "name": "Warm afternoon",
  "enabled": true,
  "nodes": [
    {
      "id": "temp-1",
      "type": "temperature",
      "position": { "x": 70, "y": 90 },
      "config": {
        "aircoId": "living-room",
        "sensor": "indoor",
        "operator": "gt",
        "value": 25
      }
    },
    {
      "id": "action-1",
      "type": "apply-preset",
      "position": { "x": 400, "y": 90 },
      "config": { "aircoId": "living-room", "presetId": "preset-id" }
    }
  ],
  "edges": [{ "id": "edge-1", "from": "temp-1", "to": "action-1" }]
}
```

Temperature operators are `gt`, `gte`, `lt` and `lte`. Time blocks contain `start`,
`end` (`HH:MM`) and `days` (`0` Sunday through `6` Saturday) and use the service's
local timezone. A `mode` condition selects `auto`, `cool`, `heat`, `fan`, or `dry`.
A `power` condition accepts an optional `durationMinutes` from `0` through `10080`.
For example, `{ "aircoId": "living-room", "state": "on", "durationMinutes": 60 }`
only matches after the unit has continuously been on for at least one hour. The start
time comes from persistent usage history, so an ongoing session survives a service
restart.

### `POST /api/automations/temperature-shortcut`

Creates a ready-to-edit graphical flow containing guarded start and stop branches:

```json
{
  "name": "Summer control",
  "aircoId": "living-room",
  "presetId": "preset-id",
  "startTemperature": 25,
  "stopStrategy": "outdoor",
  "stopTemperature": 23.5,
  "outdoorHysteresis": 1.5
}
```

`stopStrategy` can be `outdoor`, `indoor` or `none`. Outdoor control uses a configurable
`outdoorHysteresis` of 1.5 °C by default: with a 23.5 °C stop threshold, the start branch
waits for at least 25 °C outdoors. Indoor control requires the stop threshold to be
lower than the start threshold. Both strategies add an airco power-state condition so
the two branches cannot repeatedly issue opposing commands. The stop branch requires
the unit to have been on continuously for at least 30 minutes and the current operating
mode to match the selected preset, so a new cooling session cannot be stopped too soon
and manually starting Fan mode does not look like an active cooling session. Its action
defaults to `clean` with a 30-minute duration, followed by automatic power-off.

### `GET /api/automation-log`

Returns the newest automation activity first. The optional `limit` parameter is capped
at 500; `automationId` filters to one flow. Entries are recorded for executed and failed
actions, the first cooldown skip in a matching period, and flow creation, changes,
enable/disable and deletion. Action entries contain the evaluated condition messages
and measured values that explain the decision.

### `DELETE /api/automation-log`

Clears the persistent activity log and returns `{ "removed": 42 }` with the number of
discarded entries.

## Setup endpoints

These power the setup wizard in the web UI; you can also call them directly. All
write endpoints take a JSON body with at least `ip` (and optionally `port`, default
`51443`).

### `GET /api/setup/discover`

Browses the local IPv4 network for `_beaver._tcp.local` services for about two seconds:

```json
{
  "units": [
    {
      "name": "Mitsubishi WF-RAC",
      "discoveryId": "0000000000000000000000000000000000000000000000000000000000000000",
      "ip": "192.168.1.50",
      "port": 51443,
      "configured": false
    }
  ]
}
```

`discoveryId` is a SHA-256 hash of the stable DNS-SD instance identity; the underlying
service name (which can contain a MAC address) is not exposed or stored. `configured`
is true when either that identity or its current endpoint is already present in the
bridge configuration. With `AIRCO_MDNS_ENABLED=0`, this endpoint returns
`{ "units": [], "disabled": true }` and manual setup remains available.

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
