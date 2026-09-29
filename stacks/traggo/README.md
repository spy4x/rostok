# Traggo

Self-hosted time tracking tool.

## Features

- Tag-based time tracking
- Manual and timer-based entry
- Dashboard with summaries and charts
- Multi-user support
- Export time data

## Access

Web UI: `https://time.${DOMAIN}` (protected by Authelia SSO)

## Backup

Time entries data backed up nightly via Restic.

## Resources

- [Traggo GitHub](https://github.com/traggo/traggo)

## Variables

Declared in `+meta.ts`. Requires the `traefik` stack.

| Key                | Default | Meaning                       |
| ------------------ | ------- | ----------------------------- |
| `TRAGGO_MEM_LIMIT` | `128M`  | Memory limit of the container |
| `TRAGGO_CPU_LIMIT` | `0.2`   | CPU limit of the container    |

## Authelia middleware

The router uses the Traefik middleware `authelia@file`. The stack therefore needs a Traefik
file-provider middleware named `authelia` (forward-auth to Authelia). No catalog stack provides
it yet, see https://github.com/spy4x/rostok/issues/301. Without it Traefik disables the router
and the site answers 404.
