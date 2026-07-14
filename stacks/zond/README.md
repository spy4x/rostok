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

Probes defined in `zond.yaml`:

```yaml
targets:
  - name: example
    url: http://hl-example:8080/health
    interval: 30s
```

## Resources

- ~50MB RAM baseline (Deno runtime) + probe buffer
- Memory limit: 128M (was 32M — caused OOM-kill cycles in production)
- CPU limit: 0.25
- [Zond GitHub](https://github.com/spy4x/zond)
