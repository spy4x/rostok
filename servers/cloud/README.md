# Cloud Server

Primary production server. Runs critical infrastructure, email (Stalwart), and external-facing services.

**Reliability:** 99.99% — Hetzner VPS with redundant power, network, and 24/7 monitoring.
Services that must stay online (email, DNS-dependent services) run here.

## Services

**Email** - [Stalwart Mail Server](../../stacks/stalwart/)\
**Monitoring** - [Gatus](../../sharedStacks/gatus/), [Healthchecks](docs/healthchecks.md), [ntfy](../../sharedStacks/ntfy/)\
**Infrastructure** - [Traefik](../../sharedStacks/traefik/), [Syncthing](../../sharedStacks/syncthing/)

## Hardware

- **Provider**: Hetzner VPS
- **OS**: Ubuntu 22.04
- **Network**: Public IPv4, 24/7 uptime

## DNS Requirements

```dns
A       mail                <VPS-IP>
MX      @                   10 mail.yourdomain.com
TXT     @                   v=spf1 mx ip4:<VPS-IP> ~all
TXT     _dmarc              v=DMARC1; p=quarantine
TXT     mail._domainkey     v=DKIM1; k=rsa; p=<get-from-server>
PTR     <VPS-IP>            mail.yourdomain.com
```

Get DKIM public key for DNS:

```bash
docker exec hl-stalwart cat /etc/stalwart/config/keys/*/dkim/*.pem 2>/dev/null | openssl rsa -pubout 2>/dev/null | grep -v '^-----'
```

## Email Management

Accounts and aliases are managed via the Stalwart admin API/web UI at `https://stalwart.${DOMAIN}/admin`.

## Access

- Stalwart admin: `https://stalwart.${DOMAIN}/admin`
- JMAP endpoint: `https://mail.${DOMAIN}/jmap`
- Monitoring: `https://uptime.${DOMAIN}`

## Deployment

```bash
deno task deploy cloud
```

See main [README](../../README.md) for setup instructions.

**Gatus** monitors both cloud and home servers. Configure in
`.volumes/gatus/config.yaml`.

**Healthchecks** monitors cron jobs and sends email alerts via the mail server.

## Testing

```bash
# Test SMTP
telnet mail.yourdomain.com 587

# Test email deliverability
# Send to: check-auth@verifier.port25.com
# Or use: https://www.mail-tester.com

# Check DNS
dig mail.yourdomain.com +short
dig yourdomain.com MX +short
dig mail._domainkey.yourdomain.com TXT +short
```

## Troubleshooting

```bash
# Check container status
docker compose ps

# View logs
docker logs hl-stalwart
docker logs hl-gatus

# Enter mail container
docker exec -it hl-stalwart sh

# Check Stalwart queue
docker exec hl-stalwart stalwart-cli queue list
```

## Backups

Backup configs in `servers/cloud/configs/backup/`. Run backups:

```bash
deno run --env-file=.env -A scripts/backup/+main.ts
```

Configure automated backups:

```bash
ansible-playbook ansible/playbooks/backup-cronjob.yml -K --limit cloud
```

## Notes

- Gatus should monitor home server and vice versa for cross-checking
- Syncthing syncs backups between cloud and home servers
