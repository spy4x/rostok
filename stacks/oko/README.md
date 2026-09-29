# Oko

Server-side-rendered dashboard at `${OKO_DOMAIN}`. Replaces the previous
nginx-static dash. Fetches gatus badge SVGs at request time (60s
in-memory cache, single-flight). No client-side JS beyond a ~30-line
filter for the search box.

```
browser ──GET /──► oko (Go) :8080
                    │
                    ├─ 1. cache hit? return
                    ├─ 2. fetch gatus badges in parallel
                    │     ├─► uptime-cloud.${DOMAIN}
                    │     └─► uptime-home.${DOMAIN}
                    ├─ 3. parse SVG fill + %
                    ├─ 4. render HTML
                    └─ 5. cache 60s
                                     ▲
                                     │
                                 (SVG responses)
```

## Why a Go app

The previous dash was a static HTML file rendered at deploy time. That
broke two invariants:

1. Deploys should produce immutable artifacts, never call monitoring.
2. Health status is "right now" — baking it into a file lies within seconds.

Oko fetches gatus on every request, behind a 60s in-memory single-flight
cache with a background refresh ticker. One HTTP server, one binary, one
distroless image. Memory budget: ~10 MB baseline, 96 MB limit.

## Environment

The stack expects these env vars (encrypted via age64 in your deploy `.env`):

```dotenv
# Required
DOMAIN=example.com

# Comma-separated gatus FQDNs. Endpoint keys are namespaced by host
# ("uptime-cloud|home_audiobookshelf") so the list decides which gatus
# owns each key.
OKO_UPTIME_HOSTS=uptime-cloud.${DOMAIN},uptime-home.${DOMAIN}
```

The compose file passes them through. Defaults baked into the binary:

| Var                   | Default | Description         |
| --------------------- | ------- | ------------------- |
| `PORT`                | `8080`  | Listen port         |
| `UPTIME_TIMEOUT_SECS` | `5`     | Per-fetch timeout   |
| `CACHE_TTL_SECS`      | `60`    | In-memory cache TTL |

## Refresh

`https://${OKO_DOMAIN}/?refresh=1` bypasses the cache for that single
request (next request still hits the warm cache, but the forced refetch
happens immediately, blocking the caller until done). A small "refresh"
link in the footer calls this.

## Adding services

Edit the canonical list at
[`internal/config/config.go`](https://github.com/spy4x/oko/blob/main/internal/config/config.go)
in the [`spy4x/oko`](https://github.com/spy4x/oko) repo. Each entry
needs:

- `Name`, `Product`, `ProductURL` — what shows on the card
- `Endpoint` — gatus endpoint key
- `GatusHost` — which gatus server exposes that key
- `URL` — service URL, with `${DOMAIN}` substituted at render time
- `Section` — `home` / `cloud` / `offsite` / `portable`
- `Icon`, `Description` — display metadata
- `Hidden` — `true` keeps gatus fetch on but skips rendering (phasing out)

Push to `main` triggers the Woodpecker pipeline (`.woodpecker.yml`) to
build + push `ghcr.io/spy4x/oko:latest`. Watchtower (already deployed
on every server) picks up the new image and restarts the container.

## Variables

Declared in `+meta.ts`; `rostok stack add oko` writes them to the server's `.env`. Requires the `traefik` stack. The dashboard is served at `${OKO_DOMAIN}`; the service list is the file `${PATH_APPS}/configs/oko/config.json` on the server, which you provide (see "Adding services").

| Key                | Default                           | Meaning                                         |
| ------------------ | --------------------------------- | ----------------------------------------------- |
| `OKO_DOMAIN`       | `dash.${DOMAIN}`                  | Public host of the dashboard                    |
| `OKO_UPTIME_HOSTS` | `uptime-${SERVER_NAME}.${DOMAIN}` | Comma-separated Gatus hosts to read badges from |

## Resources

- ~10 MB RSS baseline (Go, distroless-static, single goroutine + cache)
- Memory limit: 96 MB
- CPU limit: 0.10 (request-scoped; parallelism is bounded by
  `UPTIME_TIMEOUT_SECS × 2` per refresh)
- [Oko GitHub](https://github.com/spy4x/oko)
