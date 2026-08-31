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
public exposure — no Traefik router, no `proxy` network. It uses host
networking for mDNS/SSDP discovery, so it binds `0.0.0.0:8123` and is
reachable from the LAN; keep it on a trusted network.

This is the path to take when you want to pair and test Zigbee devices
locally before moving the stack to the production `home` server. The Zigbee
USB dongle is passed through to the container. Config uses the absolute
`HOME_ASSISTANT_DATA_PATH` from local `.env`, outside the repo, so removing a
branch or worktree cannot remove live state.

### Prerequisites

1. Docker + Docker Compose v2 installed.
2. The Zigbee USB dongle is visible to the host:
   ```bash
   ls -l /dev/serial/by-id/
   # Expect a stable usb-<vendor>_<model>_<unique-suffix>-if00-port0 path.
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

From repo root, use the validating wrapper:

```bash
deno task home-assistant:local:up
open http://localhost:8123
```

State persists in `${HOME_ASSISTANT_DATA_PATH}`. Stop without deleting data:

```bash
deno task home-assistant:local:down
```

Data deletion is intentionally not scripted. Confirm the rendered mount with
`deno task home-assistant:local:config` before any manual deletion. The wrapper
rejects repo-contained or symlinked data paths and non-serial device paths.

Drop a local `.env` (gitignored) next to `compose.local.yml` to override the
timezone, stable data path, or Zigbee device path:

```bash
TZ=Europe/Berlin
HOME_ASSISTANT_DATA_PATH=/absolute/path/to/home-assistant
ZIGBEE_DEVICE_PATH=/dev/serial/by-id/usb-vendor_model_unique-id-if00-port0
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

### Back up and restore

The local data path must stay identical between Compose and Restic. The
dedicated task loads the same local `.env` and selects only this stack:

```bash
deno task backup:home-assistant:local
```

Run it from root's scheduled backup job: Home Assistant stores some files as
container root. Both Compose and backup tasks load the same ignored
`stacks/home-assistant/.env`; keep `HOME_ASSISTANT_DATA_PATH` absolute and
dedicated to Home Assistant.

Test restoration quarterly into a temporary directory. Restic preserves the
absolute source path beneath that directory; verify the restored subtree
before stopping Home Assistant and replacing live data. No automated in-place
restore is provided because cross-filesystem copies and interrupted promotion
need operator-controlled rollback.

Things to expect on first boot after a restore:

- Legacy snapshots taken without stopping Home Assistant may require Recorder
  recovery on first boot. Current backup workflow stops the container first.
- Integrations that point at hosts from an old network may fail until you fix
  or remove them.
- Bluetooth adapter logs `Missing NET_ADMIN/NET_RAW capabilities` — cosmetic,
  only affects BT recovery. Add `cap_add: [NET_ADMIN, NET_RAW]` to
  `compose.local.yml` if you actually need BT.
- Zigbee device list will appear once ZHA finishes initialising (≈30 s).
  If the previous dongle was different hardware, devices will show as
  unreachable and need re-pairing — ZHA's `zigbee.db` stores per-radio
  network keys.

## Resources

- [Home Assistant Documentation](https://www.home-assistant.io/docs/)
- [Integrations](https://www.home-assistant.io/integrations/)
- [ZHA docs](https://www.home-assistant.io/integrations/zha/)
- [Zigbee2MQTT](https://www.zigbee2mqtt.io/)
