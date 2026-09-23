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
```

`before.deploy.ts` bcrypt-hashes `TRAEFIK_BASIC_AUTH_PASSWORD` into
`dynamic/.htpasswd` on every deploy — no manual `htpasswd` step.
`TRAEFIK_BASIC_AUTH_USER`/`TRAEFIK_BASIC_AUTH_PASSWORD` are the only
credential keys read; a server whose `.env` still carries the pre-#210
`BASIC_AUTH_USER`/`BASIC_AUTH_BASE64`/`BASIC_AUTH_PASSWORD` must rename
them — see [PR #224](https://github.com/spy4x/rostok/pull/224) for the
full old → new key table.

## Access

- Dashboard: `https://${TRAEFIK_DOMAIN}` (default `https://traefik.${DOMAIN}`)
- Requires basic auth (`TRAEFIK_BASIC_AUTH_USER`/`TRAEFIK_BASIC_AUTH_PASSWORD`)

## Middleware

Add [middlewares](https://doc.traefik.io/traefik/middlewares/http/overview/) for authentication, rate limiting, etc. For basic auth, point at the
hook-generated `.htpasswd` (a docker label can't reference a bcrypt hash
built at deploy time the way `dashboard-auth` in `dynamic/00-base.yml`
does):

```yaml
labels:
  - "traefik.http.routers.myservice.middlewares=auth"
```

```yaml
# dynamic/*.yml (see dynamic/00-base.yml's dashboard-auth for the pattern)
http:
  middlewares:
    auth:
      basicAuth:
        usersFile: /etc/traefik/dynamic/.htpasswd
```

## Resources

- [Traefik Documentation](https://doc.traefik.io/traefik/)
- [Router Configuration](https://doc.traefik.io/traefik/routing/routers/)
- [TLS Configuration](https://doc.traefik.io/traefik/https/acme/)
