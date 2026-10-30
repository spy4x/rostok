# Gitea

Self-hosted Git service with CI/CD (Woodpecker integration).

## Features

- Git repository hosting
- Issue tracking and project boards
- Pull requests with code review
- Built-in CI/CD via Woodpecker
- Webhook integrations
- Email notifications via SMTP

## Access

Web UI: `https://${GITEA_DOMAIN}`

## Configuration

```bash
GITEA__server__ROOT_URL=https://${GITEA_DOMAIN}
GITEA__database__DB_TYPE=postgres
GITEA__mailer__ENABLED=true
GITEA__service__DISABLE_REGISTRATION=true
```

Registration disabled — admin creates accounts.

## Postgres 18

The database runs Postgres 18, in `${VOLUMES_PATH}/gitea/postgres`. An install made before rostok
1.22 keeps Postgres 16 data in `${VOLUMES_PATH}/gitea/db`: deploy stops until you move it with the
upgrade script, see [Upgrading Postgres 16 to 18](../../docs/usage/postgres-upgrade.md).
Postgres 18 needs Gitea 28.0.0 or later, which the default tag `latest` is.

## Backup

PostgreSQL dump + data directory backed up nightly via Restic.

## Resources

- [Gitea Documentation](https://docs.gitea.com/)
- [Gitea GitHub](https://github.com/go-gitea/gitea)

## Variables

Declared in `+meta.ts`. Requires the `traefik` stack. Ships `compose.yml` and `public/`
(`robots.txt`).

| Key                   | Default           | Meaning                                  |
| --------------------- | ----------------- | ---------------------------------------- |
| `GITEA_DOMAIN`        | `git.${DOMAIN}`   | Public host of the web UI and clone URLs |
| `GITEA_DB_PASSWORD`   | generated, secret | Postgres password                        |
| `GITEA_SMTP_HOST`     | asked             | SMTP server host                         |
| `GITEA_SMTP_PORT`     | `587`             | SMTP server port                         |
| `GITEA_SMTP_USERNAME` | asked             | SMTP login                               |
| `GITEA_SMTP_PASSWORD` | asked, secret     | SMTP password                            |
| `GITEA_SMTP_FROM`     | asked             | Sender address of outgoing mail          |

## Image tags

Each image takes its tag from its own variable; unset, compose uses the default below.
Under `IMAGE_POLICY=pinned`, `rostok stack add` writes the exact version, and
`rostok images update` moves it (see [commands](../../docs/commands.md)).

| Variable             | Default     | Image                           |
| -------------------- | ----------- | ------------------------------- |
| `GITEA_DB_IMAGE_TAG` | `18-alpine` | `postgres` (service `gitea-db`) |
| `GITEA_IMAGE_TAG`    | `latest`    | `gitea/gitea` (service `gitea`) |
