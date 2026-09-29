# Transmission

BitTorrent client for downloading torrents.

## Features

- Web-based interface
- RSS feed support
- Scheduling
- Blocklist support
- Remote control apps

## Access

Web UI: `https://${TRANSMISSION_DOMAIN}`

**Auth**: Authentik SSO (forward auth via Traefik). Login at
[auth.${DOMAIN}](https://auth.${DOMAIN}) grants access. See
Authelia forward-auth middleware (`authelia@file`) in `stacks/traefik/dynamic.yml`
for the full setup.

## Mobile Apps

- [Transmission Remote GUI](https://github.com/transmission-remote-gui/transgui)
- [Transdroid](http://www.transdroid.org/) (Android)

## Variables

Declared in `+meta.ts`; `rostok stack add transmission` writes them to the server's `.env`. Requires the `traefik` stack, and Authelia for the forward-auth middleware on the router. `PATH_*` keys are shared by name with other stacks (jellyfin and filebrowser use `PATH_MUSIC`): one value per key.

| Key                   | Default                  | Meaning                                    |
| --------------------- | ------------------------ | ------------------------------------------ |
| `TRANSMISSION_DOMAIN` | `torrents.${DOMAIN}`     | Public host of the web UI                  |
| `PATH_MOVIES`         | `${VOLUMES_PATH}/movies` | Host folder mounted at `/downloads/movies` |
| `PATH_SERIES`         | `${VOLUMES_PATH}/series` | Host folder mounted at `/downloads/series` |
| `PATH_MUSIC`          | `${VOLUMES_PATH}/music`  | Host folder mounted at `/downloads/music`  |
| `PATH_BOOKS`          | `${VOLUMES_PATH}/books`  | Host folder mounted at `/downloads/books`  |
| `PATH_OTHER`          | `${VOLUMES_PATH}/other`  | Host folder mounted at `/downloads/other`  |

## Resources

- [Transmission Wiki](https://github.com/transmission/transmission/wiki)
