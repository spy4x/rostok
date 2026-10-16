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

## Database

The server keeps its state and the build logs in SQLite at
`${VOLUMES_PATH}/woodpecker-server/woodpecker.sqlite`. Compose opens it in WAL mode with a 30 s
busy timeout, so parallel pipelines wait for the write lock instead of failing with
`database is locked`. The first start switches an existing database to WAL; the
`woodpecker.sqlite-wal` and `-shm` files beside it belong to the database. The backup stops the
server first, so they are copied in a consistent state.

## Image tags

Each image takes its tag from its own variable; unset, compose uses the default below.
Under `IMAGE_POLICY=pinned`, `rostok stack add` writes the exact version, and
`rostok images update` moves it (see [commands](../../docs/commands.md)).

| Variable                      | Default   | Image                                                          |
| ----------------------------- | --------- | -------------------------------------------------------------- |
| `WOODPECKER_SERVER_IMAGE_TAG` | `v3.11.0` | `woodpeckerci/woodpecker-server` (service `woodpecker-server`) |
| `WOODPECKER_AGENT_IMAGE_TAG`  | `v3.11.0` | `woodpeckerci/woodpecker-agent` (service `woodpecker-agent`)   |
