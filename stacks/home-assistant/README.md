# Home Assistant

Open source home automation platform, on the host network.

## Networking

`compose.yml` uses host networking: mDNS/SSDP/DHCP discovery of IoT devices
(Zigbee bulbs, smart plugs, sensors) does not work through the Docker bridge.
Reachable on `http://<lan-ip>:8123`, from the whole LAN. Fine on a trusted
home network, never on a public-facing host.

For public HTTPS through Traefik instead, copy `compose.traefik.yml` to
`servers/<server>/compose-override/home-assistant.yml` (the CLI deploys
`compose.yml` plus that override; it has no variant switch). The override
resets host networking, so LAN discovery stops working, and it serves a
hardcoded `home.${DOMAIN}` with no auth middleware: Home Assistant's own
login is the only protection. It is not part of the catalog metadata, so
`+meta.ts` does not require `traefik`.

## Variables

Declared in `+meta.ts`; `rostok stack add home-assistant` writes them to the
server's `.env`. Server-level keys (`VOLUMES_PATH`, `TIMEZONE`) are shared by
every stack; data lives at `${VOLUMES_PATH}/home-assistant`.

| Key                            | Default        | Meaning                            |
| ------------------------------ | -------------- | ---------------------------------- |
| `HOME_ASSISTANT_ZIGBEE_DEVICE` | `/dev/ttyUSB0` | Host path of the Zigbee USB dongle |
| `HOME_ASSISTANT_CPU_LIMIT`     | `2`            | CPU limit of the container         |
| `HOME_ASSISTANT_MEM_LIMIT`     | `2048M`        | Memory limit                       |

## Hardware

A Zigbee USB dongle is passed through as `/dev/ttyUSB0` in the container.
Set `HOME_ASSISTANT_ZIGBEE_DEVICE` if the host path differs. The container
fails to start when that device does not exist.

## Access

- `http://<lan-ip>:8123`
- With the Traefik override: `https://home.${DOMAIN}`

## Resources

- [Home Assistant Documentation](https://www.home-assistant.io/docs/)
- [Docker Installation](https://www.home-assistant.io/installation/linux#docker-compose)
