# MeTube

YouTube downloader web interface.

## Features

- Download YouTube videos/playlists
- Audio-only downloads
- Format selection
- Queue management
- Download history

## Access

Web UI: `https://metube.${DOMAIN}`

## Usage

Paste YouTube URL and click download. Files saved to configured output directory.

## Resources

- [MeTube GitHub](https://github.com/alexta69/metube)
- [yt-dlp Documentation](https://github.com/yt-dlp/yt-dlp)

## Variables

Declared in `+meta.ts`. Requires the `traefik` stack. Server-level keys (`DOMAIN`, `TIMEZONE`,
`PUID`, `PGID`) are shared by every stack.

| Key           | Default                  | Meaning                              |
| ------------- | ------------------------ | ------------------------------------ |
| `PATH_VIDEOS` | `${VOLUMES_PATH}/videos` | Host folder for video downloads      |
| `PATH_MUSIC`  | `${VOLUMES_PATH}/music`  | Host folder for audio-only downloads |

## Authelia middleware

The router uses the Traefik middleware `authelia@file`. The stack therefore needs a Traefik
file-provider middleware named `authelia` (forward-auth to Authelia). No catalog stack provides
it yet, see https://github.com/spy4x/rostok/issues/301. Without it Traefik disables the router
and the site answers 404.
