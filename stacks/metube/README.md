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

Declared in `+meta.ts`. Requires the `traefik` stack. The stack has no variables of its own;
it reads only server-level keys (`DOMAIN`, `TIMEZONE`, `PUID`, `PGID`, `PATH_VIDEOS`, `PATH_MUSIC`).
