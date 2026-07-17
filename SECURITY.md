# Security policy

## Scope and threat model

AircoBridge is designed for a trusted local network. The HTTP API has no authentication
and must not be exposed to the internet. Docker Compose binds it to `127.0.0.1` by
default; only change `AIRCO_HTTP_BIND` when access is protected at the network layer.

The bridge accepts the WF-RAC module's self-signed TLS certificate. This protects the
connection from passive inspection but does not authenticate the module. Treat the
network between the bridge and each air conditioner as trusted.

Installation credentials are stored in `config/aircos.json` or environment variables.
Keep that file private, do not attach it to issues, and do not share raw API or protocol
debug output without checking it for installation-specific data.

## Reporting a vulnerability

Do not report vulnerabilities that include credentials or installation details in a
public issue. Use GitHub's private vulnerability reporting feature when it is available
for this repository. If it is unavailable, open a minimal issue asking the maintainer
for a private contact channel without including sensitive details.

Include the affected version, impact, reproduction steps, and any suggested mitigation.
