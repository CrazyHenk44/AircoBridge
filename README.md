# AircoBridge

[![CI](https://github.com/CrazyHenk44/AircoBridge/actions/workflows/ci.yml/badge.svg)](https://github.com/CrazyHenk44/AircoBridge/actions/workflows/ci.yml)

Local HTTP bridge and web UI for **Mitsubishi Heavy Industries Smart M-Air / WF-RAC** air
conditioners. It talks directly to the WF-RAC Wi-Fi module on your LAN — no cloud, no
manufacturer account. This repo contains the Node.js service, the web interface and
protocol tooling.

## Features

- Polls one or more WF-RAC units and exposes their state over a REST API.
- Web interface for power, target temperature, mode, fan speed, vanes and 3D auto.
- Tracks power usage history (`data/airco-history.json`), including monthly totals.
- Interactive protocol-debug tool for reverse-engineering unknown status bytes.

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
ARM64 systems. The recommended setup uses the included Compose file:

```sh
git clone https://github.com/CrazyHenk44/AircoBridge.git
cd AircoBridge
make setup                      # creates .env and an empty config/aircos.json
docker compose up -d
```

`docker compose up -d` automatically pulls
`ghcr.io/crazyhenk44/aircobridge:latest` (equivalent to running `docker pull`), then
starts it with persistent configuration, history storage and the correct port mapping.

Open `http://localhost:3000` and click **"+ Add air conditioner"**. The wizard walks you
through the rest:

1. Enter the unit's IP address (find it in your router's DHCP client list; tip: give
   the unit a static lease).
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
history, and — when the bridge registered the account itself — removes that account
from the unit again, freeing up the operator slot.

### Troubleshooting

A unit should show as online within one poll interval (30 s by default). If not:

```sh
docker compose logs -f airco                  # service logs
curl -s http://localhost:3000/api/aircos      # per-unit "online" and "lastError"
```

Common causes: wrong IP, the unit is on a different VLAN/subnet, or the identity is not
registered on the unit.

Useful commands:

```sh
docker compose ps
docker compose down
make update                     # pull the newest image and restart
```

History is stored in `data/airco-history.json`; override the path with
`AIRCO_HISTORY_FILE` if needed.

By default, Compose binds the web UI to `127.0.0.1` only. If you intentionally want to
expose it on your LAN, set `AIRCO_HTTP_BIND=0.0.0.0` in `.env` and protect access at
the network layer.

## REST API

Everything the web UI does goes through a JSON API you can use from your own projects:

```sh
curl -X POST http://localhost:3000/api/aircos/living-room/power \
  -H 'content-type: application/json' \
  -d '{"power":"on"}'
```

See [docs/api.md](docs/api.md) for the full endpoint reference.

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
