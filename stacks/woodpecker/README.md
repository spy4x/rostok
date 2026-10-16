# Woodpecker CI

Self-hosted CI/CD with GitHub/Gitea/GitLab integration.

## Features

- Pipeline automation
- Docker-based builds
- GitHub/GitLab integration
- Matrix builds
- Secrets management

## Setup

1. Create OAuth app in GitHub/GitLab
2. Configure in `.env`:

```bash
HOME_WOODPECKER_GITHUB_CLIENT=...
HOME_WOODPECKER_GITHUB_SECRET=...
HOME_WOODPECKER_ADMIN=your-username
```

3. Redeploy

## Access

Web UI: `https://${WOODPECKER_DOMAIN}`

## Pipeline Config

Add `.woodpecker.yml` to repository:

```yaml
pipeline:
  build:
    image: node:18
    commands:
      - npm install
      - npm test
```

## Resources

- [Woodpecker Documentation](https://woodpecker-ci.org/docs/intro)
- [Pipeline Syntax](https://woodpecker-ci.org/docs/usage/intro)

## Variables

Declared in `+meta.ts`. Requires the `traefik` stack. Server-level keys `DOCKER_GROUP_ID`,
`PUID` and `PGID` are shared by every stack.

| Key                        | Default           | Meaning                                      |
| -------------------------- | ----------------- | -------------------------------------------- |
| `WOODPECKER_DOMAIN`        | `ci.${DOMAIN}`    | Public host of the web UI and OAuth callback |
| `WOODPECKER_AGENT_SECRET`  | generated, secret | Shared secret between server and agent       |
| `WOODPECKER_GITHUB_CLIENT` | asked             | Client ID of the GitHub OAuth app            |
| `WOODPECKER_GITHUB_SECRET` | asked, secret     | Client secret of the GitHub OAuth app        |
| `WOODPECKER_ADMIN`         | asked             | GitHub login that administers Woodpecker     |

## Database and build logs

The server keeps its state in SQLite at `${VOLUMES_PATH}/woodpecker-server/woodpecker.sqlite`,
and each step's build log in its own file under `logs/` next to it. Compose opens the database in
WAL mode with a 30 s busy timeout, so parallel pipelines wait for the write lock instead of
failing with `database is locked`. The `woodpecker.sqlite-wal` and `-shm` files beside it belong
to the database.

The `woodpecker-db` service ([`db-helper.ts`](db-helper.ts)) looks after the database:

- **Older installs.** Woodpecker used to keep build logs inside the database, where they grew it
  by gigabytes. On its first start, `woodpecker-db` writes those logs to `logs/`, removes them
  from the database and shrinks the file. The server waits for it: about 6 minutes per 4 GB of
  database. When a step had the same line twice (a workflow that ran twice), the first copy is
  kept.
- **Backup copy.** Every 15 minutes it writes a consistent copy of the live database to
  `backup/woodpecker.sqlite`.
- **Restore.** When the live database is missing at start and `backup/woodpecker.sqlite` exists,
  it puts the copy in place before the server starts.

### Backups

The nightly backup saves `backup/` and `logs/` and stops nothing, so pipelines keep running
through it. The database in a backup is at most 15 minutes older than the backup; a log file
copied while its step ran misses that step's last lines.

To restore, stop the stack, move the live `woodpecker.sqlite`, `-wal` and `-shm` files aside, run
the restore, and start the stack: `woodpecker-db` copies the restored database into place. Without
that, the restore puts back only the copy in `backup/`, the server keeps its current database, and
the next copy overwrites the restored one.

## Image tags

Each image takes its tag from its own variable; unset, compose uses the default below.
Under `IMAGE_POLICY=pinned`, `rostok stack add` writes the exact version, and
`rostok images update` moves it (see [commands](../../docs/commands.md)).

| Variable                      | Default   | Image                                                          |
| ----------------------------- | --------- | -------------------------------------------------------------- |
| `WOODPECKER_SERVER_IMAGE_TAG` | `v3.19.0` | `woodpeckerci/woodpecker-server` (service `woodpecker-server`) |
| `WOODPECKER_AGENT_IMAGE_TAG`  | `v3.19.0` | `woodpeckerci/woodpecker-agent` (service `woodpecker-agent`)   |
| `WOODPECKER_DB_IMAGE_TAG`     | `2.9.0`   | `denoland/deno` (service `woodpecker-db`)                      |
