# AdGuard Home

Network-wide ad blocking DNS server.

## Features

- DNS-level ad blocking
- Tracking protection
- Parental controls
- Custom filtering rules
- Statistics dashboard

## Configuration

| Variable            | Default         | Meaning                                       |
| ------------------- | --------------- | --------------------------------------------- |
| `ADGUARD_IMAGE_TAG` | `latest`        | Image tag                                     |
| `ADGUARD_DOMAIN`    | `dns.${DOMAIN}` | Public host of the web UI                     |
| `ADGUARD_DNS_BIND`  | `127.0.0.1`     | Address of the server the DNS ports listen on |

## What is exposed

| Port                        | Listens on                   | Reachable by                   |
| --------------------------- | ---------------------------- | ------------------------------ |
| 53/tcp, 53/udp (DNS)        | `ADGUARD_DNS_BIND`           | whoever can reach that address |
| 853/tcp (DNS-over-TLS)      | `ADGUARD_DNS_BIND`           | whoever can reach that address |
| 3000/tcp (first-run wizard) | `127.0.0.1`, fixed           | the server itself              |
| web UI                      | Traefik, at `ADGUARD_DOMAIN` | anyone who can reach Traefik   |

With the default, `127.0.0.1`, AdGuard answers DNS queries from the server itself and from nobody
else. That is deliberate: a resolver that answers the whole internet gets found within hours and
used to flood other people's servers (DNS amplification), and hosting providers suspend servers
for it.

To serve other devices, set `ADGUARD_DNS_BIND` in the server's `.env` to one address of the
server and deploy again:

- **Home network:** the server's LAN address, for example `192.168.1.10`. Only devices on that
  network reach it.
- **VPN:** the server's address inside the VPN, for example `10.8.0.1`. Only VPN peers reach it.
- **Public resolver:** `0.0.0.0`. Every interface answers, including the public one. Choose this
  only on purpose, and then open Settings → DNS settings in the AdGuard web UI and fill
  "Allowed clients" with the networks you serve, and keep the rate limit on. The host firewall may
  not protect you here: Docker publishes ports with its own rules, ahead of `ufw`'s.

The address must belong to the server; one value covers all three DNS ports.

## Setup

1. Port 53 must be free on the address you chose. On many distributions `systemd-resolved` holds
   it on `127.0.0.53`, which collides only with `0.0.0.0`: in that case set `DNSStubListener=no`
   in `/etc/systemd/resolved.conf` and restart the service.
2. First run: the setup wizard listens on port 3000 of the server, bound to `127.0.0.1` only. Open
   a tunnel (`ssh -L 3000:localhost:3000 <server>`) and visit `http://localhost:3000`. In the
   wizard, set the web interface to port **80** (Traefik forwards to it) and keep DNS on port 53
   on all interfaces: those are the container's interfaces, and `ADGUARD_DNS_BIND` decides what
   the server publishes.
3. Configure devices to use the address in `ADGUARD_DNS_BIND` as their DNS server.

## Access

Web UI: `https://<ADGUARD_DOMAIN>`

## Resources

- [AdGuard Home Documentation](https://github.com/AdguardTeam/AdGuardHome/wiki)
