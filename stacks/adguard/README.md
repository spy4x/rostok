# AdGuard Home

Network-wide ad blocking DNS server.

## Features

- DNS-level ad blocking
- Tracking protection
- Parental controls
- Custom filtering rules
- Statistics dashboard

## Configuration

| Variable            | Default         | Meaning                   |
| ------------------- | --------------- | ------------------------- |
| `ADGUARD_IMAGE_TAG` | `latest`        | Image tag                 |
| `ADGUARD_DOMAIN`    | `dns.${DOMAIN}` | Public host of the web UI |

## Setup

1. Port 53 must be free on the host. On many distributions `systemd-resolved` holds it: set
   `DNSStubListener=no` in `/etc/systemd/resolved.conf` and restart the service.
2. First run: the setup wizard listens on port 3000 of the server, bound to `127.0.0.1` only. Open
   a tunnel (`ssh -L 3000:localhost:3000 <server>`) and visit `http://localhost:3000`. In the
   wizard, set the web interface to port **80** (Traefik forwards to it) and keep DNS on port 53.
3. Configure devices to use the server's IP address as their DNS server.

Ports 53 and 853 are published on every interface. Restrict them with the host firewall unless you
want an open resolver.

## Access

Web UI: `https://<ADGUARD_DOMAIN>`

## Resources

- [AdGuard Home Documentation](https://github.com/AdguardTeam/AdGuardHome/wiki)
