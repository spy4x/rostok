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
