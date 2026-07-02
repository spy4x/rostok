# Migrate from Radicale to Stalwart (CalDAV/CardDAV)

> **Status:** ✅ Migration complete
> Replaces Radicale on home server with Stalwart's built-in CalDAV on cloud.

## Why

- Remove separate Radicale container
- Unify on Stalwart for mail + calendars + contacts
- Stalwart CalDAV/CardDAV is natively supported via JMAP + WebDAV

## Final architecture

```
Traefik (Alpine 3.23, IP 172.18.0.11)
  ↓ HTTP/2 + TLS
hl-stalwart-proxy (Python 3-alpine, IP 172.18.0.20, fixed)
  ↓ urllib HTTP/1.1
hl-stalwart (Stalwart Rust HTTP, IP 172.18.0.6)
```

The Python sidecar is required because **Traefik's Go HTTP client (Alpine 3.23 BusyBox)**
interacts poorly with **Stalwart's Rust HTTP server** — connections from certain Docker
container IPs are reset at the TCP/HTTP layer. Python urllib (Alpine 3.24) consistently
works as a bridge.

The fixed IP `172.18.0.20` avoids a quirk where dynamic IP `172.18.0.13` (assigned by
Docker Compose to the second service in a stack) consistently fails to connect to
Stalwart's HTTP port.

## What was done

1. **Traefik routers** in `stacks/stalwart/compose.yml`:
   - `hl-stalwart` → `mail.${DOMAIN}` (web UI, JMAP) — uses `stalwart-jmap@file` middleware
   - `hl-stalwart-dav` → `mail.${DOMAIN}/dav/*` (CalDAV/CardDAV) — no JMAP middleware
     (CORS headers can interfere with PROPFIND/REPORT)
   - `hl-stalwart-caldav` → `cal.${DOMAIN}` (CalDAV alias) — optional, same backend
2. **Python sidecar** `hl-stalwart-proxy` (Alpine 3.24, fixed IP 172.18.0.20)
3. **DNS** A record `cal.antonshubin.com` → `23.88.101.28` (cloud)
4. **Env** Stalwart mailbox password in `servers/home/.env` (encrypted)
5. **caldav-mcp** reconfigured with Stalwart credentials + `mail.${DOMAIN}` URL
6. **Data import** 142 VTODO tasks from 5 Radicale collections → Stalwart
   via JMAP `CalendarEvent/parse` + `CalendarEvent/set`
7. **Removed** Radicale stack, configs, dashboard, monitoring, ansible playbook

## Endpoints verified

| Endpoint | Method | Status | Notes |
|----------|--------|--------|-------|
| `mail.${DOMAIN}/.well-known/jmap` | GET | 200 | JMAP discovery |
| `mail.${DOMAIN}/jmap/session` | GET | 200 | JMAP session + capabilities |
| `mail.${DOMAIN}/jmap/` | POST | 200 | JMAP API (mail, calendars, contacts, submission) |
| `mail.${DOMAIN}/admin/` | GET | 200 | Stalwart admin UI |
| `mail.${DOMAIN}/dav/cal/` | PROPFIND | 207 | CalDAV root |
| `mail.${DOMAIN}/dav/cal/<userId>/` | PROPFIND | 207 | List user's calendars |
| `mail.${DOMAIN}/dav/cal/<userId>/<calId>/` | PROPFIND/REPORT | 207 | List/fetch VTODOs |
| `mail.${DOMAIN}/dav/card/` | PROPFIND | 207 | CardDAV root |
| `mail.${DOMAIN}/dav/card/<userId>/` | PROPFIND | 207 | List user's addressbooks |
| `cal.${DOMAIN}/...` | (any) | same as mail./dav | Optional alias |

## Client configuration

For caldav-mcp / todoapp / any CalDAV client:

- **URL**: `https://mail.antonshubin.com/dav/cal/<userId>/` (or specific calendar URL)
- **Username**: full email (`anton@antonshubin.com`)
- **Password**: Stalwart mailbox password
- **Auth**: Basic (Stalwart handles it natively)

**Important: calendar URL gotcha.** Traefik does not pass URL-encoded slashes (`%2F`)
to the backend. Calendars whose names contain slashes (e.g. "1.0 / Inbox") cannot be
accessed via the friendly URL `/dav/cal/<userId>/1.0%20%2F%20Inbox/`. Use the
UUID-based URL that Stalwart exposes for each calendar instead:

```bash
# Discover calendar URLs (UUIDs are the ones that work through Traefik)
curl -u "user:pass" -X PROPFIND -H "Depth: 1" \
  https://mail.antonshubin.com/dav/cal/USERID/
# Returns href="/dav/cal/USERID/UUID/" for each calendar
```

## Known limitations

1. **PROPFIND with %2F in path** returns 400 from Traefik. Workaround: use UUID paths.
2. **Duplicate calendars**: each import run creates a new calendar. Multiple imports
   during testing left several duplicates with similar names. Use Stalwart admin UI
   to clean up, or use the UUID paths to access the right one.
3. **cal.${DOMAIN}**: works but is redundant with `mail.${DOMAIN}/dav/*`. Kept for
   backward compatibility.

## Cleanup checklist (for human)

- [ ] Remove Radicale data volumes on home: `rm -rf /home/spy4x/apps/.volumes/radicale/`
- [ ] Delete DNS record `cal.antonshubin.com` (optional, redundant with `mail.`)
- [ ] Clean up duplicate calendars in Stalwart admin UI
- [ ] Configure todoapp CalDAV server to use `https://mail.antonshubin.com/`
      with Stalwart credentials

## Rollback

If migration fails:
1. `deno task deploy home radicale` (Radicale stack removed from repo, restore from PR #35)
2. Restore data from backup
3. Remove DNS record for `cal.${DOMAIN}`
4. Redeploy caldav-mcp with old credentials
