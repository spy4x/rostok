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
```

## Environment Variables

```bash
TRAEFIK_DOMAIN=traefik.yourdomain.com   # Full dashboard host (default: traefik.${DOMAIN})
CONTACT_EMAIL=you@email.com             # Let's Encrypt email — a server-level key, set by `server create`
TRAEFIK_BASIC_AUTH_USER=admin           # Dashboard auth (default: admin)
TRAEFIK_BASIC_AUTH_PASSWORD=...         # Dashboard auth (default: generated, 24 chars)
TRAEFIK_FORWARDED_TRUSTED_IPS=            # Optional: CIDRs whose X-Forwarded-* headers are trusted (default: none)
```

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

## Resources

- [Traefik Documentation](https://doc.traefik.io/traefik/)
- [Router Configuration](https://doc.traefik.io/traefik/routing/routers/)
- [TLS Configuration](https://doc.traefik.io/traefik/https/acme/)
