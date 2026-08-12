# AircoBridge

[![CI](https://github.com/CrazyHenk44/AircoBridge/actions/workflows/ci.yml/badge.svg)](https://github.com/CrazyHenk44/AircoBridge/actions/workflows/ci.yml)

Local HTTP bridge and web UI for **Mitsubishi Heavy Industries Smart M-Air / WF-RAC** air
conditioners. It talks directly to the WF-RAC Wi-Fi module on your LAN — no cloud, no
manufacturer account. This repo contains the Node.js service, the web interface and
protocol tooling.

![AircoBridge web interface](screenie.png)

## Features

- Polls one or more WF-RAC units and exposes their state over a REST API.
- Web interface for power, target temperature, mode, fan speed, vanes and 3D auto.
- Saves named, per-unit presets for restoring all controls with one click; a preset can
  optionally be copied to every currently configured unit.
- Tracks power usage history (`data/airco-history.json`), including monthly totals.
- Interactive protocol-debug tool for reverse-engineering unknown status bytes.
- Finds WF-RAC units that announce `_beaver._tcp.local`, stores a privacy-preserving
  discovery identity and follows later IP-address changes automatically.
- Announces itself with mDNS-SD so integrations such as Homey can discover the bridge
  and follow address changes automatically.

## Supported hardware

This bridge targets Mitsubishi Heavy Industries units with a Smart M-Air WF-RAC (or
WF-RAC-HTTPS) Wi-Fi module — the ones controlled by the "Smart M-Air" mobile app. It
speaks the module's local Beaver API on port `51443` (HTTPS with a self-signed
certificate).

It has only been tested against a single setup:

| Indoor unit | Wi-Fi module | Wireless firmware | MCU firmware |
| --- | --- | --- | --- |
| SRK50ZS-WF | WF-RAC-HTTPS | 025 | 200 |

Other WF-RAC units will likely work since they share the same protocol, but that is
untested. If you run this bridge against a different unit, please open an issue to
report whether it works (include the model and firmware versions from
`GET /api/aircos/:id?raw=1`) so this list can grow.

## Installation

You need Docker with the Compose plugin, and a WF-RAC unit that is already on your
Wi-Fi (set up once with the Smart M-Air app). The published image supports AMD64 and
ARM64 Linux systems. The recommended setup uses the included Compose file and Docker's
host network mode so mDNS discovery reaches the physical LAN:

```sh
git clone https://github.com/CrazyHenk44/AircoBridge.git
cd AircoBridge
make setup                      # creates .env and an empty config/aircos.json
docker compose up -d
```

`docker compose up -d` automatically pulls
`ghcr.io/crazyhenk44/aircobridge:latest` (equivalent to running `docker pull`), then
starts it with persistent configuration and history storage.

Open `http://localhost:3000` and click **"+ Add air conditioner"**. The wizard walks you
through the rest:

1. Select a unit found automatically through `_beaver._tcp.local`, or enter its IP
   address manually from your router's DHCP client list. Units linked through mDNS do
   not require a static DHCP lease.
2. Choose how to get access: let the bridge **register itself** on the unit (it
   generates a fresh identity, the same way the Smart M-Air app pairs a phone), or
   enter an existing `deviceId`/`operatorId`.
3. The wizard tests the connection against the live unit.
4. Give the unit a name — done. It appears with live status and controls, and is saved
   to `config/aircos.json`.

The module has four operator slots. If the wizard reports they are all taken, remove an
unused account in the Smart M-Air app and try again, or pick "reuse existing
credentials" in the wizard. Manual configuration, CLI registration and other ways to
obtain credentials are described in [docs/advanced.md](docs/advanced.md).

To remove a unit, use the delete button on its card. This also discards its usage
history and presets, and — when the bridge registered the account itself — removes that
account from the unit again, freeing up the operator slot.

### Troubleshooting

A unit should show as online within one poll interval (30 s by default). If not:

```sh
docker compose logs -f airco                  # service logs
curl -s http://localhost:3000/api/aircos      # per-unit "online" and "lastError"
```

Common causes: the unit is on a different VLAN/subnet, mDNS is blocked, or the operator
identity is not registered on the unit.

Useful commands:

```sh
docker compose ps
docker compose down
make update                     # pull the newest image and restart
```

The bridge browses for `_beaver._tcp.local` units during setup and startup, and after a
connection failure. It hashes each service identity before storing it; when the unit's
address changes, the runtime and file configuration are updated and the request is
retried once. The bridge also advertises `_aircobridge._tcp.local` on the LAN by
default. Its stable
identity is generated once in `data/bridge-id`; keep the `data` directory when moving
or updating an installation. If the host has VPN, NetBird, Docker or other virtual
interfaces, set `AIRCO_MDNS_INTERFACE` in `.env` to the physical LAN interface name
(for example `eth0`) or its host IP. Comma-separated values are also accepted. Set
`AIRCO_MDNS_ENABLED=0` only when both unit discovery and bridge advertisement are
intentionally disabled; the setup wizard then falls back to manual address entry.

Host networking is supported natively by Docker Engine on Linux. Docker Desktop users
must enable host networking in Docker Desktop 4.34 or newer. The configured
`AIRCO_HTTP_PORT` is the actual host port in this mode, so it must be free.

When upgrading an existing Compose installation, check `.env`: older releases created
`AIRCO_HTTP_BIND=127.0.0.1`, which must be changed to `0.0.0.0` or the host's physical
LAN IP for Homey and other LAN clients to connect. Then recreate the container with
`make update` (published image) or `make up-local` (local source).

History is stored in `data/airco-history.json`, and presets in
`data/airco-presets.json`. Override the paths with `AIRCO_HISTORY_FILE` and
`AIRCO_PRESETS_FILE` if needed.

By default, Compose binds the web UI to all host interfaces so LAN integrations can
reach it. To limit both HTTP and discovery to the physical LAN on a multi-homed host,
set `AIRCO_HTTP_BIND` to that host IP and set `AIRCO_MDNS_INTERFACE` to the matching IP
or interface name. Protect access at the network layer.

## REST API

Everything the web UI does goes through a JSON API you can use from your own projects:

```sh
curl -X POST http://localhost:3000/api/aircos/living-room/power \
  -H 'content-type: application/json' \
  -d '{"power":"on"}'
```

See [docs/api.md](docs/api.md) for the full endpoint reference.
Integrations can use `GET /api/info` to read the stable `bridgeId` and detect optional
bridge features such as discovery and presets while remaining compatible with older
server versions.

## Documentation

- [docs/api.md](docs/api.md) — REST API reference for integrating with your own projects.
- [docs/advanced.md](docs/advanced.md) — running without Docker, configuration details, CLI and protocol debugging.
- [docs/architecture.md](docs/architecture.md) — how the service is put together.
- [docs/mitsubishi-airco.md](docs/mitsubishi-airco.md) — WF-RAC / Beaver protocol notes.

## Security

The bridge has **no authentication** and disables TLS verification towards the unit
(the module uses a self-signed certificate). Run it only on a trusted LAN and do not
expose port 3000 to the internet. See [SECURITY.md](SECURITY.md) for the threat model and
vulnerability-reporting guidance.

## Contributing

Bug reports, compatibility reports and pull requests are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and required checks.

## Credits

Protocol knowledge builds on the reverse-engineering work of
[jeatheak/Mitsubishi-WF-RAC-Integration](https://github.com/jeatheak/Mitsubishi-WF-RAC-Integration),
[JobDoesburg/homebridge-mhi-wfrac](https://github.com/JobDoesburg/homebridge-mhi-wfrac)
and [mcheijink/WF-RAC](https://github.com/mcheijink/WF-RAC).

## License

[MIT](LICENSE)
