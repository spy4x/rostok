# Gatus

Health monitoring with HTTP/TCP checks and alerts.

## Features

- HTTP/HTTPS endpoint monitoring
- TCP port checks
- Custom conditions (status code, response time, body content)
- Push notifications via ntfy
- Historical uptime tracking

## Configuration

The stack ships a starter `config.yml` with a single self-check
endpoint (Gatus refuses to start with zero endpoints), so
`rostok stack add gatus -n` plus deploy gives a container that starts
with no manual config step. To add checks, write
`servers/{server}/configs/gatus.yml` — `before.deploy.ts` copies it over
the starter at deploy time (falls back to the starter when the file is
absent):

```yaml
storage:
  type: sqlite
  path: /data/data.db

endpoints:
  - name: MyService
    url: "https://myservice.yourdomain.com"
    interval: 5m
    conditions:
      - "[STATUS] == 200"
      - "[RESPONSE_TIME] < 1000"
    alerts:
      - type: ntfy
        failure-threshold: 2
        success-threshold: 2
        send-on-resolved: true

alerting:
  ntfy:
    url: ${NTFY_URL}
    topic: ${NTFY_TOPIC}
    token: ${NTFY_TOKEN}
```

`NTFY_URL`, `NTFY_TOPIC` and `NTFY_TOKEN` above are Gatus's own
env-var expansion — they come from this stack's `GATUS_NTFY_URL`,
`GATUS_NTFY_TOPIC_UPTIME` and `GATUS_NTFY_TOKEN_UPTIME` (set with
`rostok stack add gatus`). Leave `GATUS_NTFY_URL`/`GATUS_NTFY_TOKEN_UPTIME`
unset to run without alerting.

To probe an endpoint sitting behind Traefik basic auth, reference
`${GATUS_BASIC_AUTH_BASE64}` (base64 of `user:password`) in a check's
headers:

```yaml
endpoints:
  - name: ProtectedService
    url: "https://protected.yourdomain.com"
    interval: 5m
    headers:
      Authorization: "Basic ${GATUS_BASIC_AUTH_BASE64}"
    conditions:
      - "[STATUS] == 200"
```

Leave `GATUS_BASIC_AUTH_BASE64` unset for checks that don't need it.

The dashboard has no auth of its own — put it behind Traefik's
basic-auth or Authelia middleware if it shouldn't be public. Its router
already carries `robots-deny@file` to keep it out of search indexes.

## Access

Dashboard: `https://${GATUS_DOMAIN}` (default `https://uptime.${DOMAIN}`)

## Cross-Server Monitoring

Each server monitors others to detect failures without single point of failure. Configure checks in each server's `gatus.yml`.

## Resources

- [Gatus Documentation](https://github.com/TwiN/gatus)
- [Condition Syntax](https://github.com/TwiN/gatus#conditions)
- [Alert Configuration](https://github.com/TwiN/gatus#alerting)
