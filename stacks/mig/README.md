# mig

Tiny self-hosted meeting scheduler. One owner, one URL, one feature:
book a time slot.

**Upstream:** <https://github.com/spy4x/mig>

## What it does

Visitors land on `meet.${DOMAIN}`, pick an available date + time, fill in
name + email, and get a confirmation with a calendar invite (`.ics`).
The owner receives an email for every booking and every cancellation.
Either side can cancel via a link in the email.

No accounts, no admin UI, no database. Configuration is via env vars.
Bookings persist as a JSON file in the bind-mounted `/data` volume.

## Access

- Booking page: `https://meet.${DOMAIN}`
- Health (Gatus): `https://meet.${DOMAIN}/health`
- Embed variant: `https://meet.${DOMAIN}/embed` (no header; needs the
  setup below before any browser will show it in an iframe)

## Embedding in your own site

Out of the box every browser refuses to show mig in an iframe. The
Traefik stack applies `security-headers@file` to every response on the
`websecure` entrypoint (`stacks/traefik/compose.yml`), and mig's router
lists it again; it sends `X-Frame-Options: DENY`. That is the right
default: nobody can frame your booking page to trick a visitor into
clicking it.

A router cannot remove that header, because the entrypoint middleware
runs last on the way out and sets it again. What a router can do is add
a `Content-Security-Policy: frame-ancestors` header naming your site.
Browsers that see both headers follow `frame-ancestors` and ignore
`X-Frame-Options`: the Content Security Policy specification recommends
it and every current engine does it. Checked with both headers on one response in Chromium 153,
Firefox 155 and WebKitGTK 2.52 (the engine Safari uses; Safari itself
was not tested): the named site can frame the page, any other origin is
refused, and with `X-Frame-Options` alone everyone is refused.

1. Add a server-specific Traefik file,
   `servers/<server>/configs/traefik/dynamic/03-mig-embed.yml`:

   ```yaml
   http:
     middlewares:
       mig-frame-ancestors:
         headers:
           customResponseHeaders:
             Content-Security-Policy: "frame-ancestors 'self' https://example.com https://www.example.com"
   ```

   The other security headers keep coming from the entrypoint, so this
   file holds nothing else. `customResponseHeaders` replaces the header
   rather than adding to it: mig sends no Content Security Policy of its
   own today, but if a later release does, merge the two policies here,
   or this middleware silently deletes the application's.

2. Point the router at it in `servers/<server>/.env`:

   ```bash
   MIG_MIDDLEWARES=mig-frame-ancestors@file,compression@file,robots-deny@file
   ```

3. Deploy `traefik` first, then `mig`. The order is mandatory. The
   traefik stack's `before.deploy.ts` is what copies
   `configs/traefik/dynamic/*.yml` to the server, so deploying `mig`
   alone never installs the file. A router that names a middleware
   Traefik does not know is disabled, and the booking page answers 404
   until the file arrives.

4. Check:

   ```bash
   curl -sI https://meet.example.com/embed | grep -iE "x-frame|content-security"
   # content-security-policy: frame-ancestors 'self' https://example.com https://www.example.com
   # x-frame-options: DENY     <- still there, from the entrypoint; browsers ignore it
   ```

   Then open a page on your site that frames `/embed` and click a date.

The policy has to cover the whole host, not only `/embed`. The embed
page has no client-side routing: its date and slot links lead to
`/?date=…`, so the frame leaves `/embed` at the first click. A router
that allowed framing on `/embed` alone would show the calendar and then
a refused frame. The cost is that the frame shows the full page, header
and footer included, from the second step on.

## Configuration

All config via env vars in `${PATH_APPS}/configs/mig.env`:

```bash
# Required
HOST_NAME="Jane Doe"
HOST_EMAIL="jane@example.com"
HOST_TZ="UTC"
MEETING_URL="https://meet.google.com/abc-defg-hij"
WEEKLY_AVAILABILITY="MON-FRI 09:00-17:00"
SLOT_DURATION_MIN=30
CANCEL_SECRET="$(openssl rand -base64 32)"
SMTP_HOST="smtp.example.com"
SMTP_PORT=587
SMTP_USER="jane@example.com"
SMTP_PASS="..."
SMTP_FROM="Bookings <book@example.com>"
PUBLIC_URL="https://meet.example.com"

# Optional
MIN_NOTICE_HOURS=6
BOOKING_HORIZON_DAYS=60
RATE_LIMIT_PER_5MIN=1
THEME=auto
# BLOCKED_DATES="01.01.2027-10.01.2027,04.07.2027"
```

See <https://github.com/spy4x/mig/blob/main/.env.example> for the full
list and syntax reference.

## Resources

- ~30-60 MB RSS typical (Fresh + V8 + nodemailer)
- Memory limit: 128M
- CPU limit: 0.2

## Backup

The bookings JSON file at `${PATH_VOLUMES}/mig/bookings.json` is backed
up by Restic via this stack's `backup.ts`. The container is briefly
stopped during backup so the atomic-rename write completes before the
snapshot.

## Maintenance

- **Read all bookings**: `docker exec hl-mig cat /data/bookings.json | jq`
- **Manually trigger backup**: `deno task backup`
- **Update**: `deno task deploy` (pulls new image, restarts)
- **Rotate `CANCEL_SECRET`**: edit `mig.env`, `deno task env:encrypt`,
  redeploy. ⚠️ WARNING: rotating `CANCEL_SECRET` invalidates every
  existing cancel link. Do this only if tokens have leaked.

## Architecture

```
Browser ──HTTPS──▶ Traefik ──HTTP──▶ hl-mig:8080
                                        │
                                        ├─▶ /data/bookings.json (atomic write)
                                        └─▶ SMTP relay (port 587)
                                                   │
                                                   ├─▶ Guest (confirmation + .ics)
                                                   └─▶ Owner (notification + .ics)
```

Single process, in-memory mutex serialises writes, JSON file is the
only persistence. No DB, no cache, no cron.
