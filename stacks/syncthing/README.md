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

## Environment Variables

```bash
SYNCTHING_DOMAIN=sync.example.com  # Full host for the Traefik rule
SYNCTHING_GUI_USER=admin              # Web UI username
SYNCTHING_GUI_PASSWORD=...            # Generated password
```

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
