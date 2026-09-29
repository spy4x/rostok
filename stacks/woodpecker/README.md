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

Web UI: `https://ci.${DOMAIN}`

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

| Key                        | Default           | Meaning                                  |
| -------------------------- | ----------------- | ---------------------------------------- |
| `WOODPECKER_AGENT_SECRET`  | generated, secret | Shared secret between server and agent   |
| `WOODPECKER_GITHUB_CLIENT` | asked             | Client ID of the GitHub OAuth app        |
| `WOODPECKER_GITHUB_SECRET` | asked, secret     | Client secret of the GitHub OAuth app    |
| `WOODPECKER_ADMIN`         | asked             | GitHub login that administers Woodpecker |
