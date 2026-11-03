# Security matrix

One row per stack in the catalog: whether the internet reaches it through Traefik, who checks the
visitor, whether it joins the shared `proxy` network, and what to set before you expose it. Every
row comes from the stack's `compose.yml` labels and `+meta.ts`; the stack's README has the details.
A test (`stacks/security-matrix.test.ts`) fails when a stack has no row here.

## How to read it

- **Internet via Traefik.** "Yes" means the compose file turns Traefik on for the service and gives
  it a router on the `websecure` entrypoint (port 443), at the host shown. Traefik only routes
  containers that say `traefik.enable=true`; nothing is exposed by default. Every router also gets
  the `security-headers-base` and `compression` middlewares from the Traefik stack.
- **Who checks the visitor.**
  - *Authelia*: the router names the `authelia@file` middleware. No catalog stack defines that
    middleware yet: add it to a Traefik dynamic file as the
    [authelia README](../../stacks/authelia/README.md) shows. Until you do, Traefik drops the
    router and the site answers 404, so it fails closed.
  - *Traefik basic auth*: a password Traefik asks for before the request reaches the app.
  - *App login*: the app's own accounts. Nothing in front of it, so the app's login is the only
    lock. Marked † where the stack README does not describe the login and the row relies on the
    upstream app's documented default.
  - *Token*: a bearer token, API key or shared secret, no login page.
  - *None*: anyone who reaches the address can use it.
- **On `proxy`.** Every container on the shared `proxy` network can reach the others on it by
  container name, without going through Traefik. Authelia and basic auth sit in Traefik, so they do
  not protect a service from another container on `proxy`, nor from a WireGuard client (the
  wireguard stack joins `proxy`). A compose file that maps its `default` network to `proxy` puts
  every service without its own `networks:` list there too; the rows name those services.
- **Published ports** are host ports opened outside Traefik. They are listed in the notes.

## Matrix

| Stack | Internet via Traefik | Who checks the visitor | On `proxy` | Before you expose it |
| ----- | -------------------- | ---------------------- | ---------- | -------------------- |
| [adguard](../../stacks/adguard/README.md) | Yes, `ADGUARD_DOMAIN` (`dns.${DOMAIN}`) | App login (admin password from the first-run step in the README) | Yes | Run the first-run step before the first visit. DNS ports 53 and 853 are published on `ADGUARD_DNS_BIND`, `127.0.0.1` by default; `0.0.0.0` makes an open resolver. |
| [akaunting](../../stacks/akaunting/README.md) | Yes, `AKAUNTING_DOMAIN` | Authelia | Yes: the app and its MariaDB (`akaunting-db`) | Add the `authelia` middleware. The database is reachable from every container on `proxy`; only its password guards it. |
| [audiobookshelf](../../stacks/audiobookshelf/README.md) | Yes, `AUDIOBOOKSHELF_DOMAIN` | App login † | Yes | Create the first account right after the first deploy. |
| [authelia](../../stacks/authelia/README.md) | Yes, `AUTHELIA_DOMAIN` (`auth.${DOMAIN}`) | It is the login portal: users in `configs/authelia/users.yml` | Yes: `authelia`; `authelia-redis` stays on the stack's own network | Set `AUTHELIA_ADMIN_PASSWORD` and the SMTP keys, then add the `authelia` middleware for the stacks that use it. |
| [bulwark](../../stacks/bulwark/README.md) | Yes, `BULWARK_DOMAIN` (`webmail.${DOMAIN}`) | App login against Stalwart's JMAP; admin pages use `BULWARK_ADMIN_PASSWORD` | Yes | Finish the setup wizard right after the first deploy. |
| [caldav-mcp](../../stacks/caldav-mcp/README.md) | Only with `CALDAV_MCP_PUBLIC=true` (default `false`), at `CALDAV_MCP_DOMAIN` (`mcp.${DOMAIN}`) | Token (`CALDAV_MCP_TOKEN`); OAuth when made public | Yes | To make it public, set all three OAuth values and `CALDAV_MCP_TRUSTED_PROXIES` ("Public with OAuth" in its README). |
| [caldav-tasks-web](../../stacks/caldav-tasks-web/README.md) | Yes, `CALDAV_TASKS_WEB_DOMAIN` (`todos.${DOMAIN}`) | App login: one owner password | Yes | Write its settings file (README) before the first deploy. |
| [caldiy](../../stacks/caldiy/README.md) | Yes, `CALDIY_DOMAIN` (`schedule.${DOMAIN}`) | App login | Yes: `caldiy`; database, Redis and cron stay on the stack's own network | Create the first admin in the setup wizard right after the first deploy. |
| [ci-agent](../../stacks/ci-agent/README.md) | No: it dials out to the woodpecker server | Token: `CI_AGENT_SECRET`, a copy of the server's agent secret | No | Nothing to expose. Keep the secret private: it lets any agent join the server. |
| [cloudflared](../../stacks/cloudflared/README.md) | No: it opens an outbound tunnel to Cloudflare, which forwards to your services | None of its own; Cloudflare Access can add one | Yes | Every public hostname in the tunnel is reachable from the internet; add a Cloudflare Access policy for any that has no login. |
| [deepseek-harness](../../stacks/deepseek-harness/README.md) | No: a systemd service on the host, no compose file | Not described in its README | No | It listens on `127.0.0.1:3080` only, and its agent runs commands on the host. Put a login in front before you forward a host name to it. |
| [docker-registry](../../stacks/docker-registry/README.md) | Yes, `DOCKER_REGISTRY_DOMAIN`: the web UI, which forwards `/v2` to the registry | App login: `DOCKER_REGISTRY_USER` and `DOCKER_REGISTRY_PASSWORD` on every request | Yes: the registry and the web UI | Nothing more; anonymous access is off. |
| [docker-sock-proxy](../../stacks/docker-sock-proxy/README.md) | No | None: only containers on its internal `hl-docker-api` network reach it | No | Join only the containers that need the Docker API to `hl-docker-api`. |
| [email-mcp](../../stacks/email-mcp/README.md) | No (`traefik.enable=false`) | Token: a guard asks for `EMAIL_MCP_TOKEN` | No: its own `hl-email-mcp` network; the upstream server sits on an internal network behind the guard | Never connect the upstream service to another network: it has no authentication. |
| [filebrowser](../../stacks/filebrowser/README.md) | Yes, `FILEBROWSER_DOMAIN` | App login † | Yes | Only the app's login stands between the internet and the files you mount into it. |
| [gatus](../../stacks/gatus/README.md) | Yes, `GATUS_DOMAIN` (`uptime.${DOMAIN}`) | None: the status page is public | Yes | Add `authelia@file` or basic auth to its router if the check names are private. |
| [gitea](../../stacks/gitea/README.md) | Yes, `GITEA_DOMAIN` (`git.${DOMAIN}`) | App login; sign-up is off, the admin creates accounts | Yes: `gitea`; the database stays on the stack's own network | Nothing more. |
| [github-mcp](../../stacks/github-mcp/README.md) | No (`traefik.enable=false`) | None: whoever reaches it acts with `GITHUB_MCP_TOKEN` | No: its own `hl-github-mcp` network | Open WebUI's deploy joins it to that network; join nothing else. Give the GitHub token the smallest scope you need. |
| [google-maps-mcp](../../stacks/google-maps-mcp/README.md) | No (`traefik.enable=false`) | None: whoever reaches it spends `GOOGLE_MAPS_MCP_API_KEY` | No: its own `hl-google-maps-mcp` network | Open WebUI's deploy joins it to that network; join nothing else. |
| [healthchecks](../../stacks/healthchecks/README.md) | Yes, `HEALTHCHECKS_DOMAIN` (`healthchecks.${DOMAIN}`) | App login | Yes | Set the SMTP keys, or create the first user by hand (README); without either nobody can log in. |
| [home-assistant](../../stacks/home-assistant/README.md) | No: host network, port 8123 on every interface | App login | No (host network) | Keep it on a trusted home network. The optional `compose.traefik.yml` override serves `home.${DOMAIN}` through Traefik with no auth middleware. |
| [immich](../../stacks/immich/README.md) | Yes, `IMMICH_DOMAIN` (`photos.${DOMAIN}`) and the kiosk at `IMMICH_KIOSK_DOMAIN` (`kiosk.${DOMAIN}`) | App login; the kiosk asks for `IMMICH_KIOSK_PASSWORD` | Yes: `server` and `kiosk`; machine learning, Redis and the database stay on the stack's own network | A second router adds `IMMICH_MCP_API_KEY` to every `/api/assets/<id>/thumbnail` request, so with that key set, a thumbnail opens without a login for anyone who has its asset id. The kiosk also publishes port 3000 on every interface. |
| [jellyfin](../../stacks/jellyfin/README.md) | Yes, `JELLYFIN_DOMAIN` | App login † | Yes | Finish the setup wizard right after the first deploy. |
| [librespeed](../../stacks/librespeed/README.md) | Yes, `LIBRESPEED_DOMAIN` | None for speed tests; `LIBRESPEED_PASSWORD` guards the results and settings | Yes | Speed tests use your bandwidth; anyone with the address can run them. |
| [metube](../../stacks/metube/README.md) | Yes, `METUBE_DOMAIN` | Authelia | Yes | Add the `authelia` middleware. |
| [mig](../../stacks/mig/README.md) | Yes, `MIG_DOMAIN` (`meet.${DOMAIN}`) | None: a public booking page, no accounts | Yes | Nothing: it is meant to be public. `MIG_MIDDLEWARES` replaces its middleware chain if you want one. |
| [mirotalk](../../stacks/mirotalk/README.md) | Yes, `MIROTALK_DOMAIN` (`talk.${DOMAIN}`) | None: anyone with a room link joins | Yes: `mirotalk` and `mirotalk-cert-extract`; the TURN server runs on the host network | Set `MIROTALK_PUBLIC_IP`. The TURN server's ports are open on the host. |
| [nginx](../../stacks/nginx/README.md) | Yes, `NGINX_DOMAIN` | None: a static site, open to search engines (`allow-index`) | Yes | Put only public files in it. |
| [ntfy](../../stacks/ntfy/README.md) | Yes, `NTFY_DOMAIN` | App login and tokens; access is deny-all until you add users | Yes | Create users and tokens (README) before pointing alerts at it. |
| [oko](../../stacks/oko/README.md) | Yes, `OKO_DOMAIN` (`dash.${DOMAIN}`) | None, and open to search engines (`allow-index`) | Yes | It lists your services and their uptime; add a login middleware if that list is private. |
| [ollama](../../stacks/ollama/README.md) | Yes, `OLLAMA_DOMAIN` (`ollama.${DOMAIN}`) | Authelia | Yes | Add the `authelia` middleware. The API has no login of its own, so any container on `proxy` can use it. |
| [omni-tools](../../stacks/omni-tools/README.md) | Yes, `OMNI_TOOLS_DOMAIN` | None: public by design | Yes | Nothing. |
| [open-webui](../../stacks/open-webui/README.md) | Yes, `OPEN_WEBUI_DOMAIN` (`ai.${DOMAIN}`) | App login; sign-up off by default (`OPEN_WEBUI_ENABLE_SIGNUP=false`) | Yes: `open-webui` and `mcpo` (no route; `OPEN_WEBUI_MCPO_API_KEY` guards it) | Create the admin account right after the first deploy. |
| [pangolin](../../stacks/pangolin/README.md) | Yes, through a TLS-passthrough router you add to the main Traefik's dynamic files (README), not through compose labels | App login: Pangolin's admin and its resource logins | Yes: `pangolin` and `gerbil` | Finish `/auth/initial-setup` right after the first deploy. Gerbil publishes UDP 51820 and 21820; a file router that takes over a Pangolin host must bring its own auth (README). |
| [piped](../../stacks/piped/README.md) | Yes, `PIPED_DOMAIN`, `PIPED_API_DOMAIN` and `PIPED_PROXY_DOMAIN` | None to watch; accounts are optional | Yes: frontend, backend and proxy; the database and helper stay on the stack's own network | Anyone with the address can stream through your server. |
| [playwright](../../stacks/playwright/README.md) | No | None | No: its own `hl-playwright-mcp` network | Whoever joins the network drives a browser from your server; join only the containers that need it. |
| [searxng](../../stacks/searxng/README.md) | Yes, `SEARXNG_DOMAIN` (`search.${DOMAIN}`) | None | Yes: `searxng`; Redis stays on the stack's own network | Anyone with the address can search through your server. |
| [stalwart](../../stacks/stalwart/README.md) | Yes, `STALWART_DOMAIN` (`mail.${DOMAIN}`: web admin, JMAP, DAV) and `STALWART_MTA_STS_DOMAIN` (`mta-sts.${DOMAIN}`) | App login: `STALWART_ADMIN_PASSWORD` and the mail accounts | Yes: `stalwart`, `mta-sts` and `cert-sync` | Publishes mail ports 25, 465, 587 and 993 on the host. |
| [syncthing](../../stacks/syncthing/README.md) | Yes, `SYNCTHING_DOMAIN` | App login: `SYNCTHING_GUI_USER` and `SYNCTHING_GUI_PASSWORD`, set from the first start | Yes | Publishes 22000 (TCP and UDP) and 21027/UDP for device sync. |
| [traefik](../../stacks/traefik/README.md) | Yes: it is the entry point, ports 80 and 443 (also UDP for HTTP/3); its dashboard at `TRAEFIK_DOMAIN` | Traefik basic auth (`dashboard-auth`: `TRAEFIK_BASIC_AUTH_USER` and `TRAEFIK_BASIC_AUTH_PASSWORD`) on the dashboard | Yes | Set `TRAEFIK_FORWARDED_TRUSTED_IPS` only when another proxy sits in front of it. |
| [traggo](../../stacks/traggo/README.md) | Yes, `TRAGGO_DOMAIN` (`time.${DOMAIN}`) | Authelia | Yes | Add the `authelia` middleware. |
| [transmission](../../stacks/transmission/README.md) | Yes, `TRANSMISSION_DOMAIN` (`torrents.${DOMAIN}`) | Authelia | Yes | Add the `authelia` middleware. Publishes peer port 51413 (TCP and UDP). |
| [umami](../../stacks/umami/README.md) | Yes, `UMAMI_DOMAIN` (`stats.${DOMAIN}`), plus `/umami/` on `UMAMI_PROXY_DOMAIN` and `UMAMI_PROXY_WWW_DOMAIN` for the tracking script | App login | Yes: `umami`; the database stays on an internal network | Set `UMAMI_DB_PASSWORD` before the first start (README). |
| [usememos](../../stacks/usememos/README.md) | Yes, `USEMEMOS_DOMAIN` (`notes.${DOMAIN}`) | App login † | Yes | Create the first account right after the first deploy. |
| [vaultwarden](../../stacks/vaultwarden/README.md) | Yes, `VAULTWARDEN_DOMAIN` (`passwords.${DOMAIN}`) | App login | Yes | Sign-ups are open by default (`VAULTWARDEN_SIGNUPS_ALLOWED=true`): set it to `false` once your accounts exist. |
| [victoria-metrics](../../stacks/victoria-metrics/README.md) | No | None: the stores take no password | No: internal `metrics` and `logs` networks only | Anything you connect to those networks reads all metrics and logs. |
| [watchtower](../../stacks/watchtower/README.md) | No | Not reachable | No | It mounts the Docker socket, so it controls every container on the host. |
| [wireguard](../../stacks/wireguard/README.md) | No: UDP port 51820 published on the host | WireGuard peer keys | Yes | A peer reaches every container on `proxy` directly, past Traefik and Authelia. Hand out peer configs only to people you would give that access. |
| [woodpecker](../../stacks/woodpecker/README.md) | Yes, `WOODPECKER_DOMAIN` (`ci.${DOMAIN}`); the agent gRPC route only when `WOODPECKER_GRPC_DOMAIN` is set | Login through GitHub OAuth; agents use `WOODPECKER_AGENT_SECRET` | Yes: `woodpecker-server`; the database has no network and the agent stays on the stack's own network | Set `WOODPECKER_ADMIN`. The agent secret is the only lock on the gRPC host. |
| [xray](../../stacks/xray/README.md) | Yes, as a TCP passthrough on port 443 for the server name `XRAY_REALITY_SNI`, no HTTP router | Token: each client's id in `XRAY_CLIENTS`, plus the Reality key | Yes | Generate the Reality key and client ids as its README shows. |
| [zond](../../stacks/zond/README.md) | Yes, `ZOND_DOMAIN` (`probe-${SERVER_NAME}.${DOMAIN}`) | None | Yes | It tells anyone which of your targets are up, by name. |
