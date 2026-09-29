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

## Variables

Declared in `+meta.ts`; `rostok stack add immich` writes them to the server's `.env`. Requires the `traefik` stack and a host with an NVIDIA GPU and the NVIDIA container toolkit: the compose file uses NVENC transcoding and the CUDA machine-learning image. Photos go to `PATH_PHOTOS`. The kiosk is served at `kiosk.${DOMAIN}`.

The two API keys can only be created in Immich (Account settings, API keys) after the first deploy: leave them empty, deploy, create the keys, add them to `.env`, deploy again.

| Key                            | Default                  | Meaning                                                    |
| ------------------------------ | ------------------------ | ---------------------------------------------------------- |
| `IMMICH_DOMAIN`                | `photos.${DOMAIN}`       | Public host of the web UI                                  |
| `IMMICH_KIOSK_DOMAIN`          | `kiosk.${DOMAIN}`        | Public host of the kiosk slideshow                         |
| `IMMICH_VERSION`               | `release`                | Image tag                                                  |
| `IMMICH_DB_PASSWORD`           | generated, secret        | Postgres password                                          |
| `IMMICH_KIOSK_PASSWORD`        | generated, secret        | Password of the kiosk page                                 |
| `IMMICH_MCP_API_KEY`           | none, secret             | API key added to thumbnail requests, so inline images load |
| `IMMICH_KIOSK_API_KEY`         | none, secret             | API key the kiosk uses to read photos                      |
| `PATH_PHOTOS`                  | `${VOLUMES_PATH}/photos` | Host folder of the photo library                           |
| `IMMICH_KIOSK_EXCLUDED_PEOPLE` | none                     | Comma-separated Immich person IDs the kiosk never shows    |

## Resources

- [Immich Documentation](https://immich.app/docs/overview/introduction)
