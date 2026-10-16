# MeTube

YouTube downloader web interface.

## Features

- Download YouTube videos/playlists
- Audio-only downloads
- Format selection
- Queue management
- Download history

## Access

Web UI: `https://${METUBE_DOMAIN}`

## Usage

Paste YouTube URL and click download. Files saved to configured output directory.

## Resources

- [MeTube GitHub](https://github.com/alexta69/metube)
- [yt-dlp Documentation](https://github.com/yt-dlp/yt-dlp)

## Backup

None. The stack keeps no state of its own. Its two folders, `PATH_VIDEOS` and `PATH_MUSIC`, hold
downloaded media, which is large and can be downloaded again; back them up yourself if you want to
keep them.

## Variables

Declared in `+meta.ts`. Requires the `traefik` stack. Server-level keys (`DOMAIN`, `TIMEZONE`,
`PUID`, `PGID`) are shared by every stack.

| Key             | Default                  | Meaning                              |
| --------------- | ------------------------ | ------------------------------------ |
| `METUBE_DOMAIN` | `metube.${DOMAIN}`       | Public host of the web UI            |
| `PATH_VIDEOS`   | `${VOLUMES_PATH}/videos` | Host folder for video downloads      |
| `PATH_MUSIC`    | `${VOLUMES_PATH}/music`  | Host folder for audio-only downloads |

## Authelia middleware

The router uses the Traefik middleware `authelia@file`. The stack therefore needs a Traefik
file-provider middleware named `authelia` (forward-auth to Authelia). No catalog stack provides
it yet, see https://github.com/spy4x/rostok/issues/301. Without it Traefik disables the router
and the site answers 404.

## Image tags

Each image takes its tag from its own variable; unset, compose uses the default below.
Under `IMAGE_POLICY=pinned`, `rostok stack add` writes the exact version, and
`rostok images update` moves it (see [commands](../../docs/commands.md)).

| Variable           | Default  | Image                                        |
| ------------------ | -------- | -------------------------------------------- |
| `METUBE_IMAGE_TAG` | `latest` | `ghcr.io/alexta69/metube` (service `metube`) |
