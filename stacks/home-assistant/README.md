# Home Assistant

Open source home automation platform. Runs as a base compose file plus
one deploy variant, chosen via `-f`.

## Deploy variants

```bash
# Public HTTPS via Traefik. No auth middleware: Home Assistant's own
# login is the only protection
docker compose -f compose.yml -f compose.traefik.yml up -d

# Host networking — mDNS/SSDP/DHCP discovery of IoT devices (Zigbee
# bulbs, smart plugs, sensors) that don't work through the Docker
# bridge network. Reachable on http://localhost:8123 and
# http://<lan-ip>:8123 — fine on a trusted home network, never on a
# public-facing host.
docker compose -f compose.yml -f compose.host.yml up -d
```

## Environment

No stack-specific keys — only the server-level ones every stack shares:

```bash
VOLUMES_PATH=/srv/volumes    # local data lives at ${VOLUMES_PATH}/home-assistant
TIMEZONE=Europe/Berlin
```

`compose.traefik.yml` routes `home.${DOMAIN}` — a hardcoded subdomain,
not a `<PREFIX>_DOMAIN` key (this stack has no `+meta.ts` yet).

## Hardware

A Zigbee USB dongle is bind-mounted at `/dev/ttyUSB0` in the base
compose file. Adjust the device path if yours differs.

## Access

- Traefik variant: `https://home.${DOMAIN}`
- Host-network variant: `http://<lan-ip>:8123`

## Resources

- [Home Assistant Documentation](https://www.home-assistant.io/docs/)
- [Docker Installation](https://www.home-assistant.io/installation/linux#docker-compose)
