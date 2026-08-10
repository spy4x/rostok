# Home Assistant

Home automation platform for smart home control.

## Features

- Device integration (lights, sensors, cameras, etc.)
- Automation rules
- Energy monitoring
- Mobile app with notifications
- Voice assistant integration

## Access

Production: `https://home.${DOMAIN}` (Traefik + Authelia on the `home` server)

Local mini PC: `http://localhost:8123` — see [Local (mini PC)](#local-mini-pc) below.

## SMTP Configuration

For notification emails, configure in Home Assistant:

- Settings → System → Network → Email Notifications
- Or add to `configuration.yaml`

## Mobile App

- [iOS](https://apps.apple.com/app/home-assistant/id1099568401)
- [Android](https://play.google.com/store/apps/details?id=io.homeassistant.companion.android)

## Local (mini PC)

A second compose file — `compose.local.yml` — runs HA directly on the local
machine (laptop / mini PC) without Traefik, the `proxy` Docker network, or any
public exposure. The container listens on `http://localhost:8123` only.

This is the path to take when you want to pair and test Zigbee devices
locally before moving the stack to the production `home` server. The Zigbee
USB dongle is passed through to the container, and config is stored under
`./.volumes/home-assistant` (gitignored).

### Prerequisites

1. Docker + Docker Compose v2 installed.
2. The Zigbee USB dongle is visible to the host:
   ```bash
   ls -l /dev/serial/by-id/
   # Expect: usb-Itead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_V2_<unique-suffix>-if00-port0
   ```
   The symlink survives reboots and USB re-enumeration, unlike
   `/dev/ttyUSB0` (which can shift to `/dev/ttyUSB1` when other serial
   devices are present — a CH340 on this host occupies `ttyUSB1`).
3. Your user can read/write the device. On Fedora:
   ```bash
   sudo usermod -aG dialout $USER
   # log out and back in
   ```
   On Debian/Ubuntu the group is also `dialout`. Without this, the container
   needs to be launched with `--privileged` or the device must be `chmod 666`
   — the group route is the safer default.

### Run

From this directory:

```bash
docker compose -f compose.local.yml up -d
open http://localhost:8123
```

State persists in `./.volumes/home-assistant/`. To stop and wipe:

```bash
docker compose -f compose.local.yml down        # stop, keep data
rm -rf ./.volumes/home-assistant               # nuke (irreversible)
```

If your timezone is not `Europe/Berlin`, drop a local `.env` (gitignored)
next to `compose.local.yml`:

```bash
echo 'TZ=Europe/Berlin' > .env
```

### Zigbee: ZHA vs Zigbee2MQTT

Two integration options inside Home Assistant:

- **ZHA** — built into HA, zero extra containers. Settings → Devices &
  Services → Add Integration → "Zigbee Home Automation". The `compose.local.yml`
  already mounts the dongle at `/dev/ttyUSB0` inside the container, so ZHA
  picks it up directly. Fastest path for "just pair one bulb".
- **Zigbee2MQTT** — separate `zigbee2mqtt` container with its own web UI on
  `http://localhost:8080`, exposed to HA via the MQTT integration. Better
  device support, easier diagnostics, more setup. Add a `zigbee2mqtt`
  service to `compose.local.yml` only if ZHA misbehaves with your devices.

### Troubleshooting

- `PermissionError` on `/dev/ttyUSB0` inside the container → your host user
  is not in `dialout` (see prerequisites), or the device path in
  `compose.local.yml` is stale. Re-run `ls -l /dev/serial/by-id/` and update
  the `devices:` mapping.
- `address already in use` on port 8123 → another HA instance (or the
  official HA OS / supervised install) is bound there. Stop the other one or
  change the host port in `compose.local.yml` (requires switching off
  `network_mode: host` and adding `ports: ["8123:8123"]`).
- HA starts but no Zigbee devices appear → confirm the dongle LED blinks on
  insert; check Settings → System → Logs for `zha` / `zigbee` errors.
  Common cause: wrong device path (always use the `/dev/serial/by-id/...`
  symlink, never the raw `/dev/ttyUSB*` node).

## Resources

- [Home Assistant Documentation](https://www.home-assistant.io/docs/)
- [Integrations](https://www.home-assistant.io/integrations/)
- [ZHA docs](https://www.home-assistant.io/integrations/zha/)
- [Zigbee2MQTT](https://www.zigbee2mqtt.io/)
