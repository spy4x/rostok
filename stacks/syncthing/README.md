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

## Signing in

The web UI is on a public address, so it has a login from the first start. The user is
`SYNCTHING_GUI_USER` (default `admin`) and the password is `SYNCTHING_GUI_PASSWORD`;
`rostok stack add syncthing` generates the password and writes both to the server's `.env`.

Each time the container starts, before Syncthing serves anything, it looks at its config:

- **No GUI password yet** (a first start, or an older deployment that never set one): the login
  is set from the two variables. The container log says so in a line that starts with `[rostok]`.
- **A GUI password is already there**: it is kept, whatever the variables say. Nothing overwrites
  a password you set in the GUI.

So the variables give the first login; after that the config is the truth. To change the
password later, change it in the GUI (Actions → Settings → GUI) and put the new value in `.env`
so the two agree. A changed value in `.env` alone does nothing.

The deploy hooks do not use this login. They use `SYNCTHING_API_KEY`.

## Upgrade note: the web UI now always has a login

Before this change nothing set a GUI password, so the web UI was open to anyone who knew the
address until its owner set one by hand. An existing deployment has to do this:

1. Run `rostok stack add syncthing --server=<server>` again. It keeps every value already in
   `.env` and adds `SYNCTHING_GUI_USER` and a generated `SYNCTHING_GUI_PASSWORD`. Then
   `rostok env encrypt` and commit. Without the two keys the deploy stops before it copies
   anything and names them.
2. Deploy. What happens next depends on your deployment:
   - **You never set a GUI password.** The deploy sets the login from the two variables. Sign in
     with them from now on. Because the web UI was open, look through Actions → Settings and the
     device and folder lists once for a device or a share you do not recognise.
   - **You set a GUI password by hand.** It keeps working and is not changed. The two new
     variables are not applied; set them in `.env` to the login you use, so the file tells the
     truth.

Folders, devices, the device id and the API key are not touched in either case.

## Setup

1. Sign in to the web UI: `https://${SYNCTHING_DOMAIN}` (e.g. `sync.${DOMAIN}`)
2. Add remote devices using their device IDs
3. Share folders (typically `~/sync`)
4. Accept shares on other servers

## Variables

Declared in `+meta.ts`; `rostok stack add syncthing` writes them to the
server's `.env`. Requires the `traefik` stack. Server-level keys (`PUID`,
`PGID`) are shared by every stack.

| Key                      | Default                         | Meaning                                                    |
| ------------------------ | ------------------------------- | ---------------------------------------------------------- |
| `SYNCTHING_DOMAIN`       | `sync-${SERVER_NAME}.${DOMAIN}` | Host of the web UI (Traefik rule)                          |
| `SYNCTHING_API_KEY`      | generated, secret               | GUI API key; deploy refuses a missing or short (<16) value |
| `SYNCTHING_GUI_USER`     | `admin`                         | Web UI user, applied while the config has no GUI password  |
| `SYNCTHING_GUI_PASSWORD` | generated, secret               | Web UI password, applied the same way                      |
| `SYNCTHING_CPU_LIMIT`    | `1`                             | CPU limit of the container                                 |
| `SYNCTHING_MEM_LIMIT`    | `1024M`                         | Memory limit                                               |

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
