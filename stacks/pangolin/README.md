# Pangolin — self-hosted tunnel broker

Self-hosted identity-aware reverse proxy with WireGuard-based tunneled remote
access. Based on [fosrl/pangolin](https://github.com/fosrl/pangolin). A remote
site (a laptop, a box behind NAT) runs the Newt client, dials out to this
server, and Pangolin publishes the site's services under its own host names.

## Architecture

```
User browser
   ↓ HTTPS
<host>.${DOMAIN} → public IP of this server
   ↓
main hl-traefik (TCP+SNI passthrough, owns host:80/443)
   ↓
hl-pangolin-traefik (TLS termination, ACME via TLS-ALPN-01)
   ↓
Pangolin server (resource lookup, login)
   ↓ WireGuard tunnel (gerbil)
Newt client on the remote site
   ↓ localhost
Service on the remote site
```

## Components

- **pangolin** (`hl-pangolin`) — server + UI (Next.js) + SQLite DB
- **gerbil** (`hl-gerbil`) — server-side WireGuard tunnel and relay
- **traefik** (`hl-pangolin-traefik`) — HTTPS termination + ACME, runs in
  gerbil's network namespace
- **newt** — the remote-site client, not part of this stack (outbound tunnel,
  no inbound ports needed on the site)

## Configuration

| `+meta.ts` key                              | Default               | What it sets                                        |
| ------------------------------------------- | --------------------- | --------------------------------------------------- |
| `PANGOLIN_DOMAIN`                           | `tunnel.${DOMAIN}`    | Dashboard host in `traefik/dynamic/00-pangolin.yml` |
| `PANGOLIN_CONTAINER_NAME`                   | `hl-pangolin`         | Pangolin container name                             |
| `PANGOLIN_GERBIL_CONTAINER_NAME`            | `hl-gerbil`           | gerbil container name                               |
| `PANGOLIN_TRAEFIK_CONTAINER_NAME`           | `hl-pangolin-traefik` | Pangolin's Traefik container name                   |
| `PANGOLIN_MEM_LIMIT` / `_CPU_LIMIT`         | `1024M` / `1`         | Pangolin limits                                     |
| `PANGOLIN_GERBIL_MEM_LIMIT` / `_CPU_LIMIT`  | `128M` / `0.5`        | gerbil limits                                       |
| `PANGOLIN_TRAEFIK_MEM_LIMIT` / `_CPU_LIMIT` | `512M` / `0.5`        | Pangolin's Traefik limits                           |

The server key `CONTACT_EMAIL` becomes the ACME account address in
`traefik/traefik_config.yml`. `before.deploy.ts` writes both values into the
deployed copies of the two files and fails the deploy when either is missing or
is not a plain host name or address.

Pangolin's own settings (`dashboard_url`, `base_domain`, the gerbil endpoint)
live in `config.yml` inside the `pangolin-config` volume, written by the
initial setup. `dashboard_url` must be `https://${PANGOLIN_DOMAIN}`.

Data lives in two named volumes, `pangolin-config` (database, site keys,
gerbil's key) and `pangolin-letsencrypt` (certificates). Docker names them
`pangolin_pangolin-config` and `pangolin_pangolin-letsencrypt`, after the
compose project, so keep deploying the stack as `pangolin` (no `deployAs`) or
the containers come up with empty volumes.

Firewall: open `51820/udp` (WireGuard) and `21820/udp` (relay) on the server.

## Routing via the main hl-traefik (SNI passthrough)

The main hl-traefik owns host:80/443; hl-pangolin-traefik terminates
Pangolin's TLS. Each Pangolin host name needs both a Resource in the Pangolin
UI and an SNI router on the main Traefik, in a server file such as
`servers/<server>/configs/traefik/dynamic/02-pangolin.yml`:

```yaml
tcp:
  routers:
    pangolin-passthrough:
      rule: "HostSNI(`tunnel.example.com`) || HostSNI(`app.example.com`)"
      entryPoints:
        - websecure
      service: pangolin-gerbil
      tls:
        passthrough: true
  services:
    pangolin-gerbil:
      loadBalancer:
        servers:
          - address: "hl-gerbil:443"
```

## Server-specific Traefik files

The Pangolin Traefik reads routers from two places: Pangolin's HTTP provider
(`http://pangolin:3001/api/v1/traefik-config`, one router per Resource) and the
`traefik/dynamic/` directory. That directory holds the catalog's
`00-pangolin.yml` plus every `servers/<server>/configs/pangolin/dynamic/*.yml`,
which `before.deploy.ts` copies in on each deploy (a missing folder is fine; a
server file named `00-pangolin.yml` is refused). Use it for per-server routers,
for example a different login in front of one Pangolin host: a router at a
higher `priority` than Pangolin's own (100), using the service Pangolin
generated (`<id>-<name>-service@http`). Pangolin's router stays as the
fallback. After adding or changing such a file, deploy and then restart
`hl-pangolin-traefik` once so it is surely loaded.

## Setup (first time)

1. Add DNS records for `PANGOLIN_DOMAIN` and every host you plan to publish,
   pointing at this server, and the SNI router above.
2. Deploy: `rostok deploy <server> pangolin`
3. Wait for the healthcheck (~60s), then read the setup token:
   `docker logs hl-pangolin | grep -A1 'SETUP TOKEN'`
4. Open `https://${PANGOLIN_DOMAIN}/auth/initial-setup`, enter the token, set
   an admin password (store it outside Git).
5. **Exit Nodes** → Create, address `https://${PANGOLIN_DOMAIN}`.
6. **Sites** → Create, type **Newt** → save, copy the `id` and `secret`.
7. Install pinned Newt on the remote site (verify the checksum):
   ```bash
   curl -fL -o /tmp/newt \
     https://github.com/fosrl/newt/releases/download/1.15.0/newt_linux_amd64
   printf '%s  %s\n' \
     '25973d7f2666af5a426c84d527c1347ca1bc4a5dc081beec8a81e627bafd9dbd' \
     /tmp/newt | sha256sum --check
   install -Dm755 /tmp/newt ~/.local/bin/newt
   ```
8. Put the site `id` and `secret` into `newt.env` and run Newt as a service:
   ```bash
   cat > /etc/newt/newt.env << EOF
   PANGOLIN_ENDPOINT=https://<PANGOLIN_DOMAIN>
   NEWT_ID=<from step 6>
   NEWT_SECRET=<from step 6>
   EOF
   chmod 600 /etc/newt/newt.env
   ```
9. **Resources** → Create: subdomain `<subdomain>`, mode `http`. **Targets** →
   Add: the site, IP `127.0.0.1`, port `<port>`, method `http`.
10. Open `https://<subdomain>.${DOMAIN}/`: it serves the service on the site.

UI without the public route: `ssh -f -N -L 3002:127.0.0.1:3002 <server>`, then
`http://127.0.0.1:3002/`.

## Re-init (fresh Pangolin)

This deletes every site, resource and user:

```bash
docker compose -p pangolin down --volumes   # in PATH_APPS on the server
rostok deploy <server> pangolin
```

Then follow the setup from step 3. Removing `pangolin_pangolin-letsencrypt`
forces new certificates and can hit Let's Encrypt rate limits.

## Backup

The stack has no `backup.ts`. The rostok backup reads host folders under
`VOLUMES_PATH`, and Pangolin keeps its data in named volumes, whose host path
depends on the Docker daemon's settings. Until the backup can read a named
volume, copy `pangolin-config` by hand, for example:

```bash
docker run --rm -v pangolin_pangolin-config:/data:ro -v "$PWD":/out alpine \
  tar -C /data -czf /out/pangolin-config.tgz .
```

Losing it means re-enrolling every site.

## Known gotchas

- **newt 1.15.0 ↔ pangolin 1.21.1 protocol mismatch**: server returns
  `newt/wg/receive-config`, newt expects `newt/wg/connect`. Workaround:
  `gerbil.base_endpoint` in pangolin's `config.yml` must be host-only (no
  `https://` prefix) — the server then builds `endpoint: ${host}:51820`, which
  newt parses correctly. Keep newt pinned at 1.15.0 and pangolin at 1.21.1
  until upstream fixes this.
- **LE cert issuance**: TLS-ALPN-01 rides on port 443 via the SNI passthrough —
  no port 80 plumbing needed, but the host name must be reachable through the
  main hl-traefik first.
- **badger middleware is per-provider in traefik**: middleware names are scoped
  to the provider that defines them (`badger@file` vs `badger@http`). The file
  provider's `badger` instance does NOT share Pangolin session state with the
  HTTP provider's `badger`, so file-defined routers referencing `badger` will
  not actually gate traffic. Keep Pangolin-login routers in the HTTP provider
  (Pangolin UI Resources).
- **A file router that takes over a Pangolin host replaces Pangolin's login.**
  At a higher priority it answers instead of Pangolin's router, badger
  included, so it must carry its own auth middleware (for example
  `forwardAuth` to Authelia). A router with header-only middlewares makes the
  resource public, with no login at all.
- **volumes**: `pangolin-config` is shared — pangolin uses `/app/config`,
  gerbil writes its key to `/var/config`.
