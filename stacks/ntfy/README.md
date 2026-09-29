# ntfy

Push notification delivery for alerts and monitoring.

## Features

- Push notifications to mobile/desktop
- Topic-based subscriptions
- Authentication for private topics
- [Web interface](https://ntfy.sh/) and [mobile apps](https://docs.ntfy.sh/subscribe/phone/)

## Configuration

Users, tokens and topics live in ntfy's own database, not in `.env`. See Variables below for
what the stack reads.

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

## Variables

Declared in `+meta.ts`; `rostok stack add ntfy` writes them to the server's `.env`. Requires the `traefik` stack. Access is deny-all: create users and tokens with `docker exec -it hl-ntfy ntfy user add` and `ntfy token add`.

| Key              | Default          | Meaning                                        |
| ---------------- | ---------------- | ---------------------------------------------- |
| `NTFY_DOMAIN`    | `ntfy.${DOMAIN}` | Host of the server (Traefik rule and base URL) |
| `NTFY_CPU_LIMIT` | `0.2`            | CPU limit of the container                     |
| `NTFY_MEM_LIMIT` | `128M`           | Memory limit                                   |

## Resources

- [ntfy Documentation](https://docs.ntfy.sh/)
- [Publishing Messages](https://docs.ntfy.sh/publish/)
- [Subscribe Options](https://docs.ntfy.sh/subscribe/phone/)
