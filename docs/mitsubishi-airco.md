# Mitsubishi air conditioner control

This project controls a Mitsubishi Heavy Industries air conditioner through a Smart
M-Air WF-RAC / WF-RAC-HTTPS module. The local implementation lives in `src/wfrac.js`,
with `wfrac-lib.js` as a CLI wrapper.

## Local unit

The library assumes:

- Module IP via `WF_IP` (or per-unit `ip` in `config/aircos.json`), e.g. `192.168.1.100`.
- Device ID via `WF_DEVICE_ID` (or `deviceId` in the config file).
- Operator ID via `WF_OPERATOR_ID` (or `operatorId` in the config file).
- Aircon ID via `WF_AIRCON_ID`; default `1`.
- HTTPS on port `51443`, unless `WF_HTTPS=0`.
- Beaver endpoint: `/beaver/command/<command>`.
- User-Agent: `smartmair_app[1.4.005]`.

## Operator registration

The module keeps a list of four operator accounts and only accepts commands from
registered operators. Besides `getAirconStat`/`setAirconStat`, these commands are
implemented in `WfracClient`:

- `getDeviceInfo` (no contents): returns `airconId`, `macAddress` and `apMode`. The
  real `airconId` is the module's MAC address, although `"1"` is also accepted for
  `getAirconStat` in practice.
- `updateAccountInfo` with contents `{accountId, airconId, remote: 0, timezone}`:
  registers `accountId` (the operator ID) on the unit. `result` `0` means success,
  `2` means the operator list is full.
- `deleteAccountInfo` with contents `{accountId, airconId}`: removes the account.

The `deviceId` and `operatorId` are free-form unique strings chosen by the client; the
Smart M-Air app uses the phone identity and a UUID. This flow matches the
`jeatheak/Mitsubishi-WF-RAC-Integration` implementation and was verified against a real
unit (register, read status with the new identity, unregister).

## Protocol flow

The normal write path is:

1. Call `getAirconStat`.
2. Base64-decode `contents.airconStat`.
3. Find the active data block via `dataStart = byte18 * 4 + 21`.
4. Interpret at least its first 18 bytes as known status fields and convert them into a
   `WfracStatus`.
5. Mutate only the intended status fields.
6. Build the command and receive packets.
7. Append CRC16-CCITT.
8. Send the new base64 `airconStat` with `setAirconStat`.

This read-modify-write approach ensures that known existing fields such as mode,
temperature, fan, vanes and model information are carried along. The current code builds
a fresh command body from the known fields; unknown original bytes are not patched back
into the outgoing packet.

## Fields

`WfracStatus` currently knows:

- `operation`: on/off.
- `presetTemp`: target temperature.
- `operationMode`: writing supports auto, cool, heat, fan and dry. Reading recognises
  cool, heat, fan and dry explicitly; unknown or unrecognised mode bits are normalised
  to cool.
- `airFlow`: auto, lowest, low, high, highest. The legacy payload value `medium` keeps
  working as an alias for `low`.
- `windDirectionUD`: vertical vane, 0..4 with labels: auto, highest position, middle,
  normal, lowest position.
- `windDirectionLR`: horizontal vane, 0..7 with labels: auto, left/left, left/middle,
  middle/middle, middle/right, right/right, left/right, right/left.
- `entrust`, `coolHotJudge`, `modelNo`, `isVacantProperty`,
  `isSelfCleanOperation`, `isSelfCleanReset`, and `compressorRunning` from
  `state[9] & 0x02`.
- `indoorTemp`: indoor temperature from variable block `[128, 32, byte, flags]`,
  converted with the lookup table from `JobDoesburg/homebridge-mhi-wfrac`.
- `outdoorTemp`: outdoor temperature from variable block `[128, 16, byte, flags]`,
  converted with the lookup table from `JobDoesburg/homebridge-mhi-wfrac`.
- `electric`: current-run energy counter from variable block `[148, 16, low, high]`,
  computed as little-endian `uint16 * 0.25`.
- `errorCode`: fault code from status byte 6: `00`, `Mxx` or `Ex`.

The parser uses the first 18 bytes for basic status. Four-byte variable blocks start at
data offset 19. Known blocks:

- `[128, 32, value, flags]`: indoor temperature.
- `[128, 16, value, flags]`: outdoor temperature.
- `[148, 16, low, high]`: electric value, little-endian `uint16 * 0.25`.

## Live operation data

Values not pushed by an ordinary status poll are requested with `setAirconStat`, but
the request is read-only. The COMMAND state is 18 zero bytes with only byte 5 set to
`0xFF`; it therefore contains no set-bits and cannot write power, mode, setpoint, fan or
vane state. Its trailer contains one to three `[code, 0xFF, 0xFF, 0xFF]` requests. The
answer is parsed from the RECEIVE trailer in that same POST response.

The service polls two batches, at least one second apart, every normal 30–60 second
status interval:

- `0x90`, `0x11`, `0x85`: outdoor current, compressor frequency and discharge
  temperature.
- `0x13`, `0x81`, `0x87`: EEV position and both indoor coil thermistors.

The compressor-frequency segment's second byte is a numeric high byte. It starts at
`0x10` and continues through `0x11`, `0x12`, and so on as frequency rises; it is not the
indoor/outdoor selector used by code `0x80`. Raw four-byte segments are always retained
because some firmware reports a valid-looking zero for frequency and current even under
load.

Live power is estimated as `OP2 × 14/51 × 230`. One raw step is about 0.27 A or 63 W,
so the displayed value has approximately ±32 W quantisation uncertainty. It covers the
outdoor unit, excludes the roughly 10–30 W indoor fan, assumes 230 V and does not apply
a power-factor correction. The two coil channels use the NTC divider curve; around raw
byte 61 one byte step is about 0.4 K, so small differences between them are invisible.

Protocol source: [Mitsubishi WF-RAC module reference, sections 5.3 and 5.4](https://github.com/jeatheak/Mitsubishi-WF-RAC-Integration/blob/master/docs/wf-rac-module-reference.md#53-requesting-anything-else--the-generic-path).

The normal web interface no longer shows raw diagnostics. Raw byte tables remain
available through `GET /api/aircos/:id?debug=1` for parser work.

## Service and CLI

The primary path in this repo is the Node.js service:

```sh
npm start
```

The service reads configuration from `config/aircos.json`, `AIRCO_CONFIG_FILE`,
`AIRCO_CONFIG_JSON` or the `WF_*` environment variables.

Available CLI commands:

```sh
node wfrac-lib.js status
node wfrac-lib.js on
node wfrac-lib.js off
node wfrac-lib.js temp 21.5
node wfrac-lib.js mode cool
node wfrac-lib.js airflow auto
```

Use `wfrac-lib.js` with environment variables for diagnostics so installation data is
not embedded in scripts.
