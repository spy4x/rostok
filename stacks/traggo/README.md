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
