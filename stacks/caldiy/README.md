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

### 1. SMTP credentials (most common cause)

```bash
# Test SMTP auth from inside caldiy container
ssh home "docker exec hl-caldiy node -e 'require(\"nodemailer\").createTransport({host:\"mail.antonshubin.com\",port:587,secure:false,auth:{user:\"noreply@antonshubin.com\",pass:process.env.EMAIL_SERVER_PASSWORD},tls:{rejectUnauthorized:false}}).sendMail({from:\"noreply@antonshubin.com\",to:\"anton@antonshubin.com\",subject:\"test\",text:\"hello\"}).then(r=>console.log(\"OK\",r.messageId)).catch(e=>console.error(\"FAIL\",e.message))'"
# FAIL → goto step 2; OK → skip to step 6
```

### 2. Create noreply account on Stalwart (cloudlab)

The `noreply@antonshubin.com` account must exist on the Stalwart mailserver
(cloudlab). If missing, create it via the admin UI:

1. Go to `https://mail.antonshubin.com/admin` → Directory → Add user
2. Set name: `noreply`, email: `noreply@antonshubin.com`
3. Set password matching `SMTP_PASSWORD` in `servers/home/.env`
4. Verify with the SMTP test in step 1

### 3. Network & DNS

```bash
dig mail.antonshubin.com +short     # → cloud public IP (23.88.101.28)
nc -vz mail.antonshubin.com 587     # → open
```

### 4. STARTTLS cert

```bash
echo | openssl s_client -connect mail.antonshubin.com:587 -starttls smtp -servername mail.antonshubin.com 2>/dev/null | grep "subject="
# Expected: subject=CN=mail.antonshubin.com
```

### 5. Caldiy container logs

```bash
ssh home "docker logs hl-caldiy --tail 200 | grep -iE 'smtp|email|nodemailer|task'"
# Look for: "Invalid login" (SMTP auth), "Creating task" (emails queued)
```

### 6. Verify Cal.com workflows enabled

In the caldiy admin UI:

1. Go to **Event Types** → select event → **Workflows** tab
2. Ensure "Booking confirmation email" trigger is enabled
3. Ensure "Host notification" + "Attendee notification" are on

### 7. Check cron container is running

```bash
docker logs hl-caldiy-cron --tail 20
# Should show periodic POST to scheduleEmailReminders
```

### 8. Check pending tasks in DB

```bash
ssh home "docker exec hl-caldiy-db psql -U caldiy -d caldiy -c 'SELECT type, scheduled_at, attempts FROM \"Task\" WHERE succeeded_at IS NULL ORDER BY scheduled_at LIMIT 10'"
# Shows queued tasks waiting for cron processing
```

### 9. Create workflow via after.deploy.ts (automatic)

`stacks/caldiy/after.deploy.ts` runs during `deno task deploy`. It checks if a
`NEW_EVENT` workflow exists and creates one if missing — no manual SQL needed.

## Common Failures

| Symptom                        | Cause                                | Fix                                                    |
| ------------------------------ | ------------------------------------ | ------------------------------------------------------ |
| `ECONNREFUSED`                 | Wrong host (still `localhost`)       | Set `EMAIL_SERVER_HOST=mail.${DOMAIN}`                 |
| `ETIMEDOUT`                    | Firewall blocks home → cloud 587     | Open port 587 on cloud security group                  |
| `Invalid login: 535`           | noreply account missing/wrong pw     | Create/reset in Stalwart admin UI (step 2)             |
| `self signed certificate`      | STARTTLS chain issue                 | `NODE_TLS_REJECT_UNAUTHORIZED=0` already set           |
| `Greeting never received`      | DNS not resolving mail.${DOMAIN}     | Add Cloudflare A record → cloud public IP              |
| Emails stuck (never sent)      | Task queue processor not running     | Ensure `hl-caldiy-cron` container is up (added in fix) |
| `Invalid credentials` (CalDAV) | Stalwart creds mismatch in caldiy UI | Reconnect CalDAV integration in caldiy settings        |
