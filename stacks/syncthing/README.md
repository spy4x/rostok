# Syncthing

Continuous file synchronization for backup replication.

## Features

- Real-time file sync across servers
- Encrypted connections
- Conflict resolution
- Web-based management

## Configuration

Each server syncs backup repositories to others for redundancy:

```
Server A: ~/sync/backups/myservice
    ↓↑
Server B: ~/sync/backups/myservice
    ↓↑
Server C: ~/sync/backups/myservice
```

## Setup

1. Access web UI: `https://${SYNCTHING_DOMAIN}` (e.g. `sync.${DOMAIN}`)
2. Add remote devices using their device IDs
3. Share folders (typically `~/sync`)
4. Accept shares on other servers

## Variables

Declared in `+meta.ts`; `rostok stack add syncthing` writes them to the
server's `.env`. Requires the `traefik` stack. Server-level keys (`PUID`,
`PGID`) are shared by every stack.

| Key                   | Default                         | Meaning                                                    |
| --------------------- | ------------------------------- | ---------------------------------------------------------- |
| `SYNCTHING_DOMAIN`    | `sync-${SERVER_NAME}.${DOMAIN}` | Host of the web UI (Traefik rule)                          |
| `SYNCTHING_API_KEY`   | generated, secret               | GUI API key; deploy refuses a missing or short (<16) value |
| `SYNCTHING_CPU_LIMIT` | `1`                             | CPU limit of the container                                 |
| `SYNCTHING_MEM_LIMIT` | `1024M`                         | Memory limit                                               |

## Host paths and folders

`compose.yml` defines no volumes. Before the first deploy, add
`servers/<server>/compose-override/syncthing.yml` with the bind mounts
(config at `/var/syncthing/config`, plus your data folders), and optionally
`servers/<server>/configs/syncthing.yml` (`data_dir`, `mounts`, `folders`,
`devices`) so the deploy hooks create the host directories and reconcile
folders and devices through the REST API. Without the override the
container starts with throwaway storage.

## Folder Configuration

**Send & Receive** - Default for backup sync\
**Send Only** - For read-only distribution\
**Receive Only** - For backup targets

## Access

Web UI: `https://sync.${DOMAIN}`

## Resources

- [Syncthing Documentation](https://docs.syncthing.net/)
- [Getting Started](https://docs.syncthing.net/intro/getting-started.html)
- [Folder Types](https://docs.syncthing.net/users/foldertypes.html)
