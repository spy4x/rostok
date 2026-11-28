# FileBrowser Quantum

Web-based file manager for the server's files:
[FileBrowser Quantum](https://github.com/gtsteffaniak/filebrowser), the maintained fork of File
Browser. It replaces the [filebrowser](../filebrowser/README.md) stack, whose upstream project
is archived.

The stack is named `quantum-filebrowser`, not `filebrowser-quantum`: rostok hands a stack's hooks
every key that starts with its prefix, so `FILEBROWSER_QUANTUM_*` would also reach the
`filebrowser` stack's `FILEBROWSER_*`.

It shows the same folders as the old stack, under one source named `files`: `media`, `videos`,
`music`, `books`, `sync`, `movies`, `series` and `other`.

## Access

Web UI: `https://${QUANTUM_FILEBROWSER_DOMAIN}` (default `https://files.${DOMAIN}`).

Sign in as `admin` with the password in `QUANTUM_FILEBROWSER_ADMIN_PASSWORD`. Read it from the
server's env file in your rostok project, `servers/<server>/.env` (run `rostok env decrypt` first
on a fresh clone).

The app applies that value to the `admin` user on every start. A password changed in the web UI
therefore lasts only until the next deploy or restart: change the variable instead, then
`rostok env encrypt` and `rostok deploy <server>`.

Anonymous access and self-signup are off: every page and API call needs a signed-in user, and
only the admin creates accounts. Share links stay available to users with the share permission.

## Settings

| Variable                             | Default                  | What it does                                    |
| ------------------------------------ | ------------------------ | ----------------------------------------------- |
| `QUANTUM_FILEBROWSER_DOMAIN`         | `files.${DOMAIN}`        | Host name Traefik routes to the app             |
| `QUANTUM_FILEBROWSER_ADMIN_PASSWORD` | generated, 32 characters | Password of the `admin` user (secret)           |
| `QUANTUM_FILEBROWSER_IMAGE_TAG`      | `stable`                 | Image tag of `ghcr.io/gtsteffaniak/filebrowser` |
| `PATH_MEDIA` … `PATH_OTHER`          | `${VOLUMES_PATH}/<name>` | Host folders mounted under `/srv/<name>`        |

The `PATH_*` keys are server-level and shared by name with the filebrowser and jellyfin stacks:
one value per key in the server's `.env`.

Everything else is in [`config.yaml`](config.yaml), which holds no secret: one source over
`/srv`, password sign-in with signup off, and the update check off. The
[configuration docs](https://filebrowserquantum.com/en/docs/configuration/) list every key.

## Data and backup

- `${VOLUMES_PATH}/quantum-filebrowser/data`: the SQLite database (users, shares, settings). The
  backup covers this folder.
- `${VOLUMES_PATH}/quantum-filebrowser/cache`: thumbnails and archive downloads, rebuilt by the
  app and left out of the backup.

The mounted folders are not part of this stack's backup.

## Moving from filebrowser

1. `rostok stack add quantum-filebrowser` on the server, then `rostok stack remove filebrowser`.
   Both use `files.${DOMAIN}` by default, so do not run them side by side on one host name.
2. `rostok deploy <server>`.
3. Sign in as `admin` and create the other users again.

The old stack's users, settings and share links do not carry over: the two apps keep different
databases. The files themselves are untouched, since both stacks only mount the same folders.
`${VOLUMES_PATH}/filebrowser` keeps the old database until you delete it.

## Resources

- [FileBrowser Quantum documentation](https://filebrowserquantum.com/en/docs/)
- [Source and releases](https://github.com/gtsteffaniak/filebrowser)
