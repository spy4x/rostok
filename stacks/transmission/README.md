# Transmission

BitTorrent client for downloading torrents.

## Features

- Web-based interface
- RSS feed support
- Scheduling
- Blocklist support
- Remote control apps

## Access

Web UI: `https://torrents.${DOMAIN}`

**Auth**: Authentik SSO (forward auth via Traefik). Login at
[auth.${DOMAIN}](https://auth.${DOMAIN}) grants access. See
Authelia forward-auth middleware (`authelia@file`) in `stacks/traefik/dynamic.yml`
for the full setup.

## Mobile Apps

- [Transmission Remote GUI](https://github.com/transmission-remote-gui/transgui)
- [Transdroid](http://www.transdroid.org/) (Android)

## Variables

No stack-owned variables. Requires the `traefik` stack, and Authelia for the forward-auth middleware on the router. Downloads go to the server-level `PATH_MOVIES`, `PATH_SERIES`, `PATH_MUSIC`, `PATH_BOOKS` and `PATH_OTHER`.

| Key | Default | Meaning |
| --- | ------- | ------- |

## Resources

- [Transmission Wiki](https://github.com/transmission/transmission/wiki)
