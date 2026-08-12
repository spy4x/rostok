# Immich

Self-hosted photo and video management with mobile backup.

## Features

- Automatic mobile photo backup
- Face recognition
- Object detection
- Timeline view
- Shared albums
- Live photos support

## Access

Web UI: `https://photos.${DOMAIN}`

Kiosk: `https://kiosk.${DOMAIN}`

## Mobile Apps

- [iOS App](https://apps.apple.com/app/immich/id1613945652)
- [Android App](https://play.google.com/store/apps/details?id=app.alextran.immich)

Configure server URL: `https://photos.${DOMAIN}`

## Configuration

See [localStacks/immich/](../localStacks/immich/) for hardware acceleration configs.

## Kiosk

Slideshow frontend at `https://kiosk.${DOMAIN}` (`stacks/immich/compose.yml`
service `kiosk`). Env-driven settings live in `servers/home/.env` under the
`KIOSK_*` prefix.

### Cross-origin embedding

The kiosk endpoint is intentionally embeddable from any origin (e.g. HomeAssistant
showing a random photo). CORS is enabled globally via Traefik's
`security-headers` middleware in `stacks/traefik/dynamic/00-base.yml`
(`Access-Control-Allow-Origin: *`, no `Cross-Origin-{Opener,Resource}-Policy`).
This applies to all services, not just kiosk.

## Resources

- [Immich Documentation](https://immich.app/docs/overview/introduction)
