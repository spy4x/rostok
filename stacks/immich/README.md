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

## Mobile Apps

- [iOS App](https://apps.apple.com/app/immich/id1613945652)
- [Android App](https://play.google.com/store/apps/details?id=app.alextran.immich)

Configure server URL: `https://photos.${DOMAIN}`

## Configuration

See [localStacks/immich/](../localStacks/immich/) for hardware acceleration configs.

## Immich Kiosk

Kiosk mode for a TV or tablet, at `https://kiosk.${DOMAIN}`.

Two version constraints are coupled here, and breaking either one takes the
kiosk down in a way that looks like a Traefik fault but is not:

1. **The kiosk image tag is pinned** in `compose.yml` and opted out of
   Watchtower. Kiosk checks the Immich server version at startup and exits 1
   when its build needs a newer server than is running. A `latest` tag let
   Watchtower install a kiosk built for Immich 3.2.0 onto an Immich 3.1.0
   server, which crash-looped the container.
2. **The Immich server version** comes from `${IMMICH_VERSION}`, defaulting
   to the upstream `release` tag.

Kiosk exposes no status route, so when it exits Traefik loses its only
backend and returns a bare 404. Nothing alerts on this — the failure is
silent apart from the 404. Raise the kiosk tag and `${IMMICH_VERSION}`
together, then confirm both:

```bash
docker logs hl-immich-kiosk --tail 5   # expect "Kiosk listening on port 3000" and no version error
curl -o /dev/null -w '%{http_code}\n' https://kiosk.${DOMAIN}   # 401 is healthy: the kiosk password gate
```

`401` is the expected answer, not a fault: `KIOSK_PASSWORD` puts an
"Unauthorized Access" page in front of the kiosk.

## Resources

- [Immich Documentation](https://immich.app/docs/overview/introduction)
