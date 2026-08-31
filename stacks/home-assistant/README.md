# Home Assistant

Home automation platform for smart home control.

## Features

- Device integration (lights, sensors, cameras, etc.)
- Automation rules
- Energy monitoring
- Mobile app with notifications
- Voice assistant integration

## Access

Reachable on the `home` server via `https://home.${DOMAIN}` (Traefik + Authelia).
Local LAN access works the same way once the host resolves the server's
hostname; the host networking the previous `compose.local.yml` provided is
not required.

## Storage

State lives at `${VOLUMES_PATH}/home-assistant` like every other stack —
outside the repo, safe across branch and worktree changes. Backed up by the
nightly Restic cron when this stack is listed in
`servers/<server>/config.json` (see `backup.ts`).

## SMTP Configuration

For notification emails, configure in Home Assistant:

- Settings → System → Network → Email Notifications
- Or add to `configuration.yaml`

## Mobile App

- [iOS](https://apps.apple.com/app/home-assistant/id1099568401)
- [Android](https://play.google.com/store/apps/details?id=io.homeassistant.companion.android)

## Zigbee USB dongle

The compose file binds `/dev/ttyUSB0` to the container. Use the stable
`/dev/serial/by-id/...` symlink on your own machine if `/dev/ttyUSB0` shifts
between reboots or when other serial devices are plugged in:

```bash
ls -l /dev/serial/by-id/
# Expect a usb-<vendor>_<model>_<unique-suffix>-if00-port0 path.
```

Your host user needs read/write access to the device:

```bash
sudo usermod -aG dialout $USER
# log out and back in
```

## Restore from Restic backup

The `home-assistant` Restic repo lives under `${PATH_BACKUPS}/home-assistant`.
Restore through the standard interactive task:

```bash
deno task backup:restore home-assistant
```

Pick a snapshot, the script restores it to a temp dir and asks for explicit
confirmation before replacing live data. Stop Home Assistant first if the
container is still running.

Things to expect on first boot after a restore:

- A `Recorder` warning about the SQLite DB — normal, HA repairs on first
  write.
- Integrations that point at hosts from an old network may fail until you fix
  or remove them.

## Resources

- [Home Assistant Documentation](https://www.home-assistant.io/docs/)
- [Integrations](https://www.home-assistant.io/integrations/)
- [ZHA docs](https://www.home-assistant.io/integrations/zha/)
- [Zigbee2MQTT](https://www.zigbee2mqtt.io/)
