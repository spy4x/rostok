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

Web UI: `https://git.${DOMAIN}`

## Configuration

```bash
GITEA__server__ROOT_URL=https://git.${DOMAIN}
GITEA__database__DB_TYPE=postgres
GITEA__mailer__ENABLED=true
GITEA__service__DISABLE_REGISTRATION=true
```

Registration disabled — admin creates accounts.

## Backup

PostgreSQL dump + data directory backed up nightly via Restic.

## Resources

- [Gitea Documentation](https://docs.gitea.com/)
- [Gitea GitHub](https://github.com/go-gitea/gitea)
