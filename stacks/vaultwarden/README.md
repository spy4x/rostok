# Vaultwarden

Self-hosted password manager compatible with Bitwarden clients.

## Features

- Password vault with browser extensions
- Secure password sharing
- TOTP 2FA generator
- Emergency access
- Organizations for team sharing

## Configuration

SMTP for password resets and emergency access (optional — omit to run
without email):

```bash
VAULTWARDEN_SMTP_HOST=mail.example.com
VAULTWARDEN_SMTP_PORT=587
VAULTWARDEN_SMTP_FROM=noreply@example.com
VAULTWARDEN_SMTP_USERNAME=noreply@example.com
VAULTWARDEN_SMTP_PASSWORD=...
```

## Sign-ups

Sign-ups are off by default (`VAULTWARDEN_SIGNUPS_ALLOWED=false`), so a stranger who finds the host
cannot open an account on your server. To create the first account:

1. Set `VAULTWARDEN_SIGNUPS_ALLOWED=true` in `servers/<server>/.env`.
2. Deploy: `rostok deploy <server> vaultwarden`.
3. Open the web vault and create your account.
4. Set `VAULTWARDEN_SIGNUPS_ALLOWED=false` again and deploy again.

Add more people afterwards from an organization in the web vault (Members, Invite member). With
SMTP set they get an invitation e-mail; without SMTP they can sign up with the invited address
while sign-ups stay off. `VAULTWARDEN_INVITATIONS_ALLOWED=false` turns invitations off too.

**Existing installs** keep the value already in their `.env`. A server set up before this default
changed has `VAULTWARDEN_SIGNUPS_ALLOWED=true` there: set it to `false` and deploy, unless you
want anyone who reaches the host to be able to sign up.

## Client addresses

Vaultwarden limits failed logins per client address, so it must see each visitor's own address.
It reads it from the header named in `VAULTWARDEN_IP_HEADER`, `X-Real-Ip` by default. Traefik
drops any `X-Real-Ip` a visitor sends and sets it to the address the connection came from, so a
visitor cannot pick their own address and nothing needs setting.

**Behind Cloudflare**, proxied DNS or the cloudflared tunnel, every request reaches Traefik from a
Cloudflare or tunnel address. Cloudflare strips any `X-Real-Ip` a visitor sends, so Traefik writes
that Cloudflare address, and all visitors share one limit. Cloudflare puts the visitor's address in
its own header instead:

```env
VAULTWARDEN_IP_HEADER=CF-Connecting-IP
```

Do this only with the cloudflared tunnel and ports 80 and 443 closed to the internet, or with
Cloudflare's
[Authenticated Origin Pulls](https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/).
A firewall that accepts only [Cloudflare's ranges](https://www.cloudflare.com/ips/) is not enough:
a Cloudflare Worker in someone else's account can send any `CF-Connecting-IP` it likes, and so can a
visitor who reaches Traefik directly.

## Access

- Web Vault: `https://${VAULTWARDEN_DOMAIN}` (default `https://passwords.${DOMAIN}`)
- Admin Panel: `https://${VAULTWARDEN_DOMAIN}/admin` (requires `VAULTWARDEN_ADMIN_TOKEN`)

## Clients

Download [Bitwarden clients](https://bitwarden.com/download/):

- Browser extensions (Chrome, Firefox, etc.)
- Desktop apps (Windows, macOS, Linux)
- Mobile apps (iOS, Android)

Point to self-hosted server: `https://passwords.${DOMAIN}`

## Backup

Automated daily via Restic. Database and attachments backed up.

## Resources

- [Vaultwarden Wiki](https://github.com/dani-garcia/vaultwarden/wiki)
- [Bitwarden Help](https://bitwarden.com/help/)
