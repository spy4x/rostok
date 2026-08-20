# Zond

Internal health probe bridge — probes Docker containers and returns 200/503 status.

## Features

- Probes containers on the proxy network
- Health check endpoint for external monitoring
- No auth needed (no sensitive data exposed)
- Ultra-lightweight (~32MB RAM, 0.1 CPU)
- YAML-based probe configuration

## Access

- Probe endpoint: `https://probe-${SERVER_NAME}.${DOMAIN}`
- Returns `200 OK` if all probes pass, `503 Service Unavailable` on failure

## Configuration

Probes defined in `servers/home/configs/zond.yaml` (deployed to
`<PATH_APPS>/configs/zond.yaml`, mounted into the container via
`$ZOND_CONFIG_PATH`):

```yaml
targets:
  - name: example
    url: http://hl-example:8080/health
    interval: 30s
```

The yaml is server-specific — it lists which containers actually run on this
homelab. Other servers that want to run zond would commit their own copy under
`stacks/zond/` or in their own server's `configs/`.

## Resources

- ~5MB RSS baseline (Go, distroless-static)
- Memory limit: 64M
- CPU limit: 0.25
- [Zond GitHub](https://github.com/spy4x/zond)
