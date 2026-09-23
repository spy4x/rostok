# Jellyfin

Media server for movies, TV shows, and music.

## Features

- Stream to any device
- Live TV & DVR support
- Hardware transcoding
- Multiple user profiles
- Mobile apps

## Access

Web UI: `https://${JELLYFIN_DOMAIN}` (default `https://movies.${DOMAIN}`)

## Configuration

`PATH_MEDIA`, `PATH_VIDEOS` and `PATH_MUSIC` are host directories
mounted into the container (default `${VOLUMES_PATH}/media`,
`${VOLUMES_PATH}/videos`, `${VOLUMES_PATH}/music`). They're server-level
keys — filebrowser declares the same three and both stacks share one
value per key.

## Clients

- [Official apps](https://jellyfin.org/downloads/) for all platforms
- Android TV, Roku, Fire TV, Apple TV supported

## Media Organization

```
/media/
  movies/
    Movie Name (Year)/
      Movie Name (Year).mkv
  tv/
    Show Name/
      Season 01/
        Show Name S01E01.mkv
```

See [Jellyfin naming guide](https://jellyfin.org/docs/general/server/media/shows/).

## Hardware Acceleration

Configured for NVIDIA NVENC/NVDEC (RTX 3070). See [Jellyfin HWA docs](https://jellyfin.org/docs/general/administration/hardware-acceleration/).

## Resources

- [Jellyfin Documentation](https://jellyfin.org/docs/)
