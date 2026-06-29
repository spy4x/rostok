# Cal.diy

[Cal.diy](https://cal.diy) is the open-source community edition of Cal.com — a scheduling platform (Calendly alternative).

## Subdomain

`schedule.${DOMAIN}`

## Setup

1. Deploy the stack
2. Open `https://schedule.${DOMAIN}`
3. Complete the setup wizard to create the first admin user
4. Configure event types, availability, and integrations via the UI

## Environment Variables

| Variable                 | Description                                               |
| ------------------------ | --------------------------------------------------------- |
| `CALDIY_DB_PASSWORD`     | PostgreSQL password                                       |
| `CALDIY_NEXTAUTH_SECRET` | NextAuth secret (generate with `openssl rand -base64 32`) |
| `CALDIY_VERSION`         | Image tag (default: `latest`)                             |

## Notes

- First run triggers database migrations automatically
- Configure via UI after initial setup
- SMTP uses the `stalwart` stack on the home server (replaces the old `mailserver` stack on the cloud server)
- DNS for `mail.${DOMAIN}` → cloud server public IP (Cloudflare A record)
- STARTTLS cert: Let's Encrypt via Traefik's `myresolver` (CN=mail.${DOMAIN})

## Email Troubleshooting

If confirmation/notification emails aren't being delivered, verify in this order:

### 1. Network & DNS (verified working as of 2026-06-23)

```bash
dig mail.antonshubin.com +short     # → cloud public IP
nc -vz mail.antonshubin.com 587     # → open
```

### 2. STARTTLS cert

```bash
echo | openssl s_client -connect mail.antonshubin.com:587 -starttls smtp -servername mail.antonshubin.com 2>/dev/null | grep "subject="
# Expected: subject=CN=mail.antonshubin.com
```

### 3. Account exists on mailserver

```bash
ssh cloud "docker exec mailserver setup email list"
# Expected line: noreply@antonshubin.com
```

If missing, create it:

```bash
ssh cloud "docker exec -it mailserver setup email add noreply@antonshubin.com"
# Enter the same password as SMTP_PASSWORD in servers/home/.env
```

### 4. Caldiy container logs

```bash
ssh home "docker logs hl-caldiy --tail 200 | grep -iE 'smtp|email|nodemailer'"
# Look for: "Invalid login", "ECONNREFUSED", "ETIMEDOUT", "self signed certificate"
```

### 5. Test send directly from caldiy

```bash
ssh home "docker exec hl-caldiy node -e \"
  require('nodemailer').createTransport({
    host: 'mail.${DOMAIN}', port: 587, secure: false,
    auth: { user: 'noreply@\${DOMAIN}', pass: process.env.EMAIL_SERVER_PASSWORD },
    tls: { rejectUnauthorized: false }
  }).sendMail({ from: 'noreply@\${DOMAIN}', to: 'anton@antonshubin.com', subject: 'test', text: 'hello' }).then(r => console.log('OK', r.messageId)).catch(e => console.error('FAIL', e.message))
\""
```

### 6. Verify Cal.com workflows enabled

In the caldiy admin UI:

1. Go to **Event Types** → select event → **Workflows** tab
2. Ensure "Booking confirmation email" trigger is enabled
3. Ensure "Host notification" + "Attendee notification" are on

## Common Failures

| Symptom                   | Cause                             | Fix                                          |
| ------------------------- | --------------------------------- | -------------------------------------------- |
| `ECONNREFUSED`            | Wrong host (still `localhost`)    | Set `EMAIL_SERVER_HOST=mail.${DOMAIN}`       |
| `ETIMEDOUT`               | Firewall blocks home → cloud 587  | Open port 587 on cloud security group        |
| `Invalid login: 535`      | noreply account missing/wrong pw  | `setup email add noreply@antonshubin.com`    |
| `self signed certificate` | StarTTLS chain issue              | `NODE_TLS_REJECT_UNAUTHORIZED=0` already set |
| `Greeting never received` | DNS not resolving mail.\${DOMAIN} | Add Cloudflare A record → cloud public IP    |
