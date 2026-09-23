# ntfy

Push notification delivery for alerts and monitoring.

## Features

- Push notifications to mobile/desktop
- Topic-based subscriptions
- Authentication for private topics
- [Web interface](https://ntfy.sh/) and [mobile apps](https://docs.ntfy.sh/subscribe/phone/)

## Configuration

```bash
NTFY_DOMAIN=ntfy.example.com # Full host for the Traefik rule + NTFY_BASE_URL
NTFY_AUTH_USER=admin            # Admin user
NTFY_AUTH_PASSWORD=...          # Generated password
NTFY_TOPIC=homelab-alerts       # Topic name
```

## Usage

**Subscribe to alerts**:

1. Install [ntfy app](https://docs.ntfy.sh/subscribe/phone/)
2. Subscribe to: `https://ntfy.${DOMAIN}/homelab-alerts`
3. Set auth credentials

**Send test notification**:

```bash
curl -H "Authorization: Bearer $NTFY_AUTH_TOKEN" \
  -d "Test message" \
  https://ntfy.example.com/homelab-alerts
```

## Integration

Gatus uses ntfy for alerting. Configure in `gatus.yml`:

```yaml
alerting:
  ntfy:
    topic: homelab-alerts
    url: https://ntfy.example.com
    token: ${NTFY_AUTH_TOKEN}
```

## Access

Web UI: `https://${NTFY_DOMAIN}` — no default yet (no `+meta.ts` wizard
for this stack); set it in `servers/<server>/.env`, e.g. `ntfy.${DOMAIN}`.

## Resources

- [ntfy Documentation](https://docs.ntfy.sh/)
- [Publishing Messages](https://docs.ntfy.sh/publish/)
- [Subscribe Options](https://docs.ntfy.sh/subscribe/phone/)
