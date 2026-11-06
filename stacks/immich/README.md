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

Web UI: `https://${IMMICH_DOMAIN}`

## Mobile Apps

- [iOS App](https://apps.apple.com/app/immich/id1613945652)
- [Android App](https://play.google.com/store/apps/details?id=app.alextran.immich)

Configure server URL: `https://${IMMICH_DOMAIN}`

## Configuration

See [localStacks/immich/](../localStacks/immich/) for hardware acceleration configs.

## Variables

Declared in `+meta.ts`; `rostok stack add immich` writes them to the server's `.env`. Requires the `traefik` stack and a host with an NVIDIA GPU and the NVIDIA container toolkit: the compose file uses NVENC transcoding and the CUDA machine-learning image. Photos go to `PATH_PHOTOS`. The kiosk is served at `${IMMICH_KIOSK_DOMAIN}`.

The kiosk's API key can only be created in Immich (Account settings, API keys) after the first deploy: leave it empty, deploy, create the key, add it to `.env`, deploy again.

| Key                            | Default                              | Meaning                                                       |
| ------------------------------ | ------------------------------------ | ------------------------------------------------------------- |
| `IMMICH_DOMAIN`                | `photos.${DOMAIN}`                   | Public host of the web UI                                     |
| `IMMICH_KIOSK_DOMAIN`          | `kiosk.${DOMAIN}`                    | Public host of the kiosk slideshow                            |
| `IMMICH_VERSION`               | `release`                            | Image tag of the server, and of machine-learning with `-cuda` |
| `IMMICH_KV_IMAGE_TAG`          | `8-bookworm@sha256:ff21…`            | Image tag of `valkey` (service `kv`), pinned by digest        |
| `IMMICH_DB_IMAGE_TAG`          | `14-vectorchord0.3.0-pgvectors0.2.0` | Image tag of Immich's `postgres` (service `db`)               |
| `IMMICH_KIOSK_IMAGE_TAG`       | `latest`                             | Image tag of `immich-kiosk`                                   |
| `IMMICH_DB_PASSWORD`           | generated, secret                    | Postgres password                                             |
| `IMMICH_KIOSK_PASSWORD`        | generated, secret                    | Password of the kiosk page                                    |
| `IMMICH_KIOSK_API_KEY`         | none, secret                         | API key the kiosk uses to read photos                         |
| `PATH_PHOTOS`                  | `${VOLUMES_PATH}/photos`             | Host folder of the photo library                              |
| `IMMICH_KIOSK_EXCLUDED_PEOPLE` | none                                 | Comma-separated Immich person IDs the kiosk never shows       |

## Access without a login

Every Immich URL needs a login, thumbnails included: the stack adds no API key to any request. The
kiosk publishes no port on the server; open it at
`https://${IMMICH_KIOSK_DOMAIN}/?password=<IMMICH_KIOSK_PASSWORD>`. Without the password it shows
"Unauthorized". Keep that URL private: the password ends up in browser history and access logs.

**Existing installs.** Earlier versions of this stack added `IMMICH_MCP_API_KEY` to every
`/api/assets/<id>/thumbnail` request, so anyone who knew an asset id saw its thumbnail, and
published the kiosk on port 3000 of every interface. The next `rostok deploy <server> immich`
removes both. After it:

- Delete the key you created for `IMMICH_MCP_API_KEY` in Immich (Account settings, API keys) and
  remove its line from `servers/<server>/.env`. Nothing uses it any more.
- Point a screen that opened `http://<server>:3000` at `https://${IMMICH_KIOSK_DOMAIN}` instead,
  and keep its `?password=` part.

## Resources

- [Immich Documentation](https://immich.app/docs/overview/introduction)
