# Zond

Internal health probe bridge — probes Docker containers and returns 200/503 status.

## Features

- Probes containers on the proxy network
- Health check endpoint for external monitoring
- No auth needed (no sensitive data exposed)
- Ultra-lightweight (~32MB RAM, 0.1 CPU)
- YAML-based probe configuration

## Access

- Probe endpoint: `https://${ZOND_DOMAIN}`
- Returns `200 OK` if all probes pass, `503 Service Unavailable` on failure

## Variables

`rostok stack add zond` writes these to the server's `.env`. Requires the
`traefik` stack.

| Key              | Default                          | Meaning                    |
| ---------------- | -------------------------------- | -------------------------- |
| `ZOND_DOMAIN`    | `probe-${SERVER_NAME}.${DOMAIN}` | Host of the probe endpoint |
| `ZOND_CPU_LIMIT` | `0.25`                           | CPU limit of the container |
| `ZOND_MEM_LIMIT` | `64M`                            | Memory limit               |

## Configuration

The stack ships a starter `config.yml` with one target (Traefik), so deploy
gives a container that starts with no manual step. To probe your own
services, write `servers/<server>/configs/zond.yaml`; `before.deploy.ts`
copies it over the starter at deploy time (the starter stays when the file is
absent):

```yaml
port: 8080

targets:
  - name: example
    url: http://hl-example:8080/health
```

Target URLs use container names on the `proxy` network.

## Monitoring it from gatus

Zond answers for services that have no public URL. Point a
[gatus](../gatus/README.md) check, on this server or another, at
`https://<ZOND_DOMAIN>/health/<target name>` and expect `[STATUS] == 200`.

## Resources

- ~5MB RSS baseline (Go, distroless-static)
- Memory limit: 64M
- CPU limit: 0.25
- [Zond GitHub](https://github.com/spy4x/zond)
