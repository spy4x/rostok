# Security Matrix

Domain → access → auth method → robots-deny — audited per deployed stack.

## Legend

| Column | Meaning |
|---|---|
| Server | Which server the stack runs on |
| Domain | External DNS name (if exposed via Traefik) |
| Auth method | Authentication at the reverse-proxy layer. Stack may have additional own auth |
| robots-deny | `X-Robots-Tag: noindex, nofollow` applied via Traefik middleware |
| Internal | No Traefik exposure — accessed only via Docker DNS |
| Public | No proxy auth, no own auth, intentionally accessible |

## Home Server (46 stacks)

### Exposed via Traefik

| Stack | Domain | Auth method | robots-deny | Notes |
|---|---|---|---|---|
| adguard | dns.* | Own auth | Yes | DNS ad-blocker, own admin login |
| akaunting | invoices.* | Authelia SSO | Yes | Accounting |
| audiobookshelf | books.* | Own auth | Yes | Audiobooks |
| authelia | auth.* | None (is auth provider) | Yes | SSO/2FA provider |
| caldiy | schedule.* | Own auth | Yes | Cal.com scheduling |
| docker-registry | registry.* | Own auth | Yes | Private Docker registry + UI |
| filebrowser | files.* | Own auth | Yes | File management |
| gatus | uptime-home.* | **Public** | Yes | Health status page |
| gitea | git.* | Own auth | Yes | Git hosting, registration disabled |
| grafana | metrics.* | Authelia SSO | Yes | Grafana (VM datasources) |
| immich | photos.* | Own auth | No | Photo management, own login |
| immich (kiosk) | kiosk.* | Own auth | No | Slideshow mode |
| immich (thumb) | photos.* | API key middleware | Yes | Thumbnail proxy |
| jellyfin | movies.* | Own auth | Yes | Media server |
| librespeed | speed-home.* | **Public** (optional PASSWORD) | Yes | Speed test |
| metube | metube.* | Authelia SSO | Yes | YouTube downloader |
| mirotalk | talk.* | **Public** (room-based) | Yes | P2P video calls |
| monica | crm.* | Authelia SSO | Yes | CRM |
| monica (API) | crm.* | None (Bearer token) | — | API router bypasses Authelia |
| nginx (dash) | dash.* | **Public**, SEO-allowed | No | Dashboard landing page |
| ntfy | ntfy-home.* | Own auth | Yes | Notifications, deny-all default |
| ollama | ollama.* | Authelia SSO | Yes | LLM inference |
| omni-tools | tools.* | **Public** | Yes | Client-side browser tools |
| open-webui | ai.* | Own auth | Yes | AI chat, signup disabled |
| opencode-web | code.* | Authelia SSO | Yes | OpenCode web (systemd service) |
| paperless-ngx | docs.* | Own auth | No | Document management |
| piped | piped.* | **Public** | Yes | YouTube frontend |
| reitti | loc.* | **Public** | Yes | Public transit routing |
| searxng | search.* | **Public** | Yes | Meta-search engine |
| syncthing | sync-home.* | Own auth | Yes | File sync |
| traefik | proxy-home.* | Basic auth (dashboard-auth@file) | No | Reverse proxy dashboard |
| traggo | time.* | Authelia SSO | Yes | Time tracking |
| transmission | torrents.* | Authelia SSO | Yes | BitTorrent |
| umami | stats.* | Own auth | Yes | Web analytics |
| usememos | notes.* | Own auth | Yes | Lightweight notes |
| vaultwarden | passwords.* | Own auth | Yes | Password manager |
| woodpecker | ci.* | Own auth (GitHub OAuth) | Yes | CI/CD |
| zond | probe-home.* | **Public** | No | Health probe bridge |

### Internal (no Traefik exposure)

| Stack | Purpose | Notes |
|---|---|---|
| caldav-mcp | MCP server — calendar access | Internal Docker DNS |
| docker-sock-proxy | Docker socket proxy | Security-restricted |
| email-mcp | MCP server — email access | Internal Docker DNS |
| github-mcp | MCP server — GitHub API | Internal Docker DNS |
| google-maps-mcp | MCP server — Maps API | Internal Docker DNS |
| playwright | Playwright browser automation | Internal |
| victoria-metrics | VM, vmagent, vmlogs, node-exporter, cadvisor, promtail | All internal, no Traefik |
| watchtower | Auto-updater | No web UI |
| wireguard | VPN server | Port-based (UDP 51820), no web UI |

## Cloud Server (11 stacks)

| Stack | Domain | Auth method | robots-deny | Notes |
|---|---|---|---|---|
| bulwark | webmail.* | Own auth | Yes | JMAP webmail |
| gatus | uptime-cloud.* | **Public** | Yes | Health status page |
| healthchecks | healthchecks.* | Own auth | Yes | Cron monitoring, registration closed |
| librespeed | speed-cloud.* | **Public** | Yes | Speed test |
| nginx (neatsoft-landing) | neatsoft.dev | **Public**, SEO-allowed | No | Company landing page |
| ntfy | ntfy-cloud.* | Own auth | Yes | Notifications |
| stalwart | mail.* | Own auth | Yes | Mail server, own admin |
| stalwart (CalDAV) | mail.* | Own auth | — | Sub-route for CalDAV/CardDAV |
| stalwart (MTA-STS) | mta-sts.* | **Public** | — | MTA-STS policy |
| syncthing | sync-cloud.* | Own auth | Yes | File sync |
| traefik | proxy-cloud.* | Basic auth (dashboard-auth@file) | No | Reverse proxy dashboard |

## Offsite Server (4 stacks)

| Stack | Domain | Auth method | robots-deny | Notes |
|---|---|---|---|---|
| librespeed | speed-offsite.* | **Public** | Yes | Speed test |
| syncthing | sync-offsite.* | Own auth | Yes | File sync |
| traefik | proxy-offsite.* | Basic auth (dashboard-auth@file) | No | Reverse proxy dashboard |
| watchtower | — | Internal | No | Auto-updater |

## Not Deployed (have compose, not in any config.json)

| Stack | Domain | Notes |
|---|---|---|
| cloudflared | — | Not deployed anywhere |
| home-assistant | home.* | Compose exists, undeployed |

## Summary

| Category | Count | Details |
|---|---|---|
| Authelia SSO (2FA) | 8 | akaunting, grafana, metube, monica, ollama, opencode-web, transmission, traggo |
| Basic auth (proxy) | 2 | traefik (dashboard-auth@file) |
| Own auth (no proxy) | 18 | adguard, audiobookshelf, bulwark, caldiy, docker-registry, filebrowser, gitea, healthchecks, immich, jellyfin, ntfy, open-webui, stalwart, syncthing, umami, usememos, vaultwarden, woodpecker |
| Public (no auth) | 10 | gatus (both), librespeed (all), mirotalk, omni-tools, piped, reitti, searxng, usememos (GUI), zond |
| Public + SEO | 2 | dash landing page, neatsoft landing page |
| Internal (no Traefik) | 9 | caldav-mcp, docker-sock-proxy, email-mcp, github-mcp, google-maps-mcp, playwright, victoria-metrics, watchtower, wireguard |

### Key risks

1. **robot-deny missing** on immich (main), paperless-ngx, traefik, zond
2. **No proxy auth** on docker-registry (should be behind at least basic auth)
3. **Public services** piped, searxng, mirotalk, omni-tools are accessible worldwide
4. **Authelia migration incomplete** per [auth.md](auth.md) — metube, ollama, traggo,
   grafana, victoria-metrics still pending switch
5. **zond** intentionally public (health probes), but crawlers may find and index it
6. **immich kiosk mode** has no robots-deny — slideshow pages could be indexed

## Reconciliation process

1. Add `robots-deny@file` to stacks missing it (see key risks above)
2. Add auth to `docker-registry` (at least basic auth)
3. Complete Authelia migration per [auth.md](auth.md) Phase 1
4. Re-audit after each change — update this matrix
5. Consider this matrix the source of truth for auth decisions

## References

- [Auth infrastructure plan](auth.md)
- [Adding services guide](adding-services.md) — §Auth section
- [Architecture overview](architecture.md)
