# Traefik

Reverse proxy with automatic SSL via Let's Encrypt.

## Features

- HTTP/HTTPS routing via subdomains
- Automatic [Let's Encrypt](https://letsencrypt.org/) SSL certificates
- [Docker provider](https://doc.traefik.io/traefik/providers/docker/) for service discovery
- Dashboard for monitoring routes

## Configuration

Services expose themselves via Docker labels:

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.myservice.rule=Host(`myservice.${DOMAIN}`)"
  - "traefik.http.routers.myservice.entrypoints=websecure"
  - "traefik.http.routers.myservice.tls.certresolver=myresolver"
  - "traefik.http.routers.myservice.middlewares=frame-deny@file,robots-deny@file"
```

Every router on `websecure` gets `security-headers-base@file` (HSTS, `nosniff`, permissions and
opener policies) from the entrypoint, but not `X-Frame-Options`. List `frame-deny@file` in the
router's own middlewares, as above, or any site can show the service in a frame. Leave it out only
for a page that must be framed, such as mig's `/embed`. An entrypoint middleware runs outside every
router's chain, so a header it sets cannot be removed by a router; that is why `X-Frame-Options`
is set per router (spy4x/rostok#318). `security-headers@file` is the base headers plus
`frame-deny`, for a chain that names every security header itself.

## Environment Variables

```bash
TRAEFIK_DOMAIN=traefik.example.com      # Full dashboard host (default: traefik.${DOMAIN})
CONTACT_EMAIL=you@example.com           # Let's Encrypt email — a server-level key, set by `server create`
TRAEFIK_BASIC_AUTH_USER=admin           # Dashboard auth (default: admin)
TRAEFIK_BASIC_AUTH_PASSWORD=...         # Dashboard auth (default: generated, 24 chars)
TRAEFIK_FORWARDED_TRUSTED_IPS=            # Optional: CIDRs whose X-Forwarded-* headers are trusted (default: none)
TRAEFIK_PROXY_IP=                         # Optional: fixed address on the proxy network (default: Docker picks)
```

Set `TRAEFIK_PROXY_IP` when a service behind Traefik must trust `X-Forwarded-For` from Traefik
alone, such as caldav-mcp's `CALDAV_MCP_TRUSTED_PROXIES`. Pick an unused address inside the
`proxy` network's subnet (`docker network inspect proxy`), such as the last one, which Docker
hands out last.

Only list a proxy you control in `TRAEFIK_FORWARDED_TRUSTED_IPS`: a trusted address may set
`X-Forwarded-For`, `X-Forwarded-Host` and the other `X-Forwarded-*` headers for every router on
the `websecure` entrypoint, not just the one it needs them for.

`before.deploy.ts` bcrypt-hashes `TRAEFIK_BASIC_AUTH_PASSWORD` into
`dynamic/.htpasswd` on every deploy — no manual `htpasswd` step.
`TRAEFIK_BASIC_AUTH_USER`/`TRAEFIK_BASIC_AUTH_PASSWORD` are the only
credential keys read; a server whose `.env` still carries the pre-#210
`BASIC_AUTH_USER`/`BASIC_AUTH_BASE64`/`BASIC_AUTH_PASSWORD` must rename
them — see [PR #224](https://github.com/spy4x/rostok/pull/224) for the
full old → new key table.

## Access

- Dashboard: `https://${TRAEFIK_DOMAIN}/dashboard/` (default `https://traefik.${DOMAIN}`);
  `/dashboard` without the slash redirects there
- Requires basic auth (`TRAEFIK_BASIC_AUTH_USER`/`TRAEFIK_BASIC_AUTH_PASSWORD`)
- The API and dashboard are served only there. Port 8080 on the `proxy` network answers
  `GET /ping` for health checks and nothing else; `--api.insecure` used to serve the whole API
  there, without a password, to every container on `proxy` (spy4x/rostok#356).

## Middleware

Add [middlewares](https://doc.traefik.io/traefik/middlewares/http/overview/) for authentication, rate limiting, etc. For basic auth, reuse the
existing file-defined `dashboard-auth` middleware (`dynamic/00-base.yml`)
instead of inventing a new one — it already points at the hook-generated
`.htpasswd`, which a docker label can't reference directly (the label
would need a bcrypt hash built at deploy time, not the plaintext
`TRAEFIK_BASIC_AUTH_PASSWORD`). The `@file` suffix is required — it's
defined in a file provider, not this service's own docker labels:

```yaml
labels:
  - "traefik.http.routers.myservice.middlewares=dashboard-auth@file"
```

## Per-server dynamic config

`dynamic/00-base.yml` holds the middlewares every server gets. A server adds its own routers,
services and middlewares without touching the catalog: put `.yml` or `.yaml` files in the
project's `servers/<server>/configs/traefik/dynamic/`. On every deploy `before.deploy.ts` copies
them next to `00-base.yml`, and Traefik's file provider loads the whole folder. Other file types,
folders and symlinks are skipped. A file named like a catalog file (`00-base.yml`) replaces it,
so pick another name unless that is what you want.

For example, `servers/home/configs/traefik/dynamic/10-cors.yml`:

```yaml
http:
  middlewares:
    app-cors:
      headers:
        customResponseHeaders:
          Access-Control-Allow-Origin: "https://app.example.com"
```

A router then uses it as `app-cors@file`.

### Upgrade note: what left `00-base.yml`

- The `stalwart-jmap` middleware, which allowed one installation's webmail origin on every server,
  is gone. The `stalwart` stack now defines the same headers on its own router, with the origin
  from `STALWART_WEBMAIL_ORIGIN` (default `https://webmail.${DOMAIN}`). Nothing to add when your
  webmail is at that host; see the stalwart README otherwise. If a router of your own used
  `stalwart-jmap@file`, define that middleware in a file of your own as shown above.
  Deploy the whole server, or `stalwart` before `traefik`: a stalwart stack deployed before this
  upgrade still names `stalwart-jmap@file`, and Traefik switches off a router whose middleware is
  missing (`https://mail.<domain>/` answers 404). The stalwart README, "Upgrading from
  `STALWART_NEATSOFT_DOMAIN`", has the recovery.
- `robots-deny` and `allow-index` are unchanged. Only comments that named particular sites went.

### Upgrade note: `X-Frame-Options` moved to the routers

The entrypoint middleware is now `security-headers-base`, which sends no `X-Frame-Options`, and
`frame-deny` sends it per router (spy4x/rostok#318). Every catalog router lists `frame-deny@file`
or `security-headers@file`, but a router gets it only when its own stack is deployed with this
version. Run a full `rostok deploy <server>`: deploying `traefik` alone leaves every other stack's
routers without `X-Frame-Options` until each of those stacks is deployed. A chain that names
`security-headers@file`, such as a `MIG_MIDDLEWARES` or `CALDAV_*_MIDDLEWARES` override, keeps
`X-Frame-Options: DENY` too.

A router of your own loses `X-Frame-Options: DENY` on the first deploy of this version unless
its chain names one of the two: a router in `servers/<server>/configs/traefik/dynamic/`, a label
in a `compose-override` file that sets a router's middlewares, or a container outside rostok on
the `proxy` network, such as a website run by its own compose project. Add `frame-deny@file` to
each after the new traefik stack is deployed (before that, Traefik does not know the middleware
and switches the router off), or accept that the site relies on its own `frame-ancestors` policy
alone. Check with `curl -sI https://<host>/ | grep -i x-frame-options`.

## Resources

- [Traefik Documentation](https://doc.traefik.io/traefik/)
- [Router Configuration](https://doc.traefik.io/traefik/routing/routers/)
- [TLS Configuration](https://doc.traefik.io/traefik/https/acme/)
