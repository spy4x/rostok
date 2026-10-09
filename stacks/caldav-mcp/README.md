# caldav-mcp

CalDAV MCP server providing calendar/todo access to AI assistants.

## Features

- Exposes CalDAV calendars/todos as MCP tools
- Native Deno implementation, zero npm dependencies
- Direct CalDAV protocol with proper VTODO/VEVENT support
- Used by OpenCode AI for calendar operations

## Access

Internal by default — no external web UI. Three access modes:

1. **Docker HTTP (default)** — reachable inside Docker network at `hl-caldav-mcp:3000`
   (used by OpenWebUI, n8n, anything that can do HTTP).
2. **Local stdio** — for OpenCode running on the host. Launched via a script in
   `~/sync/code/mcps/caldav/start.sh` (see [OpenCode MCP setup](#opencode-mcp-setup) below).
3. **Public with OAuth** — opt-in per server, for remote connectors such as claude.ai (see
   [Public with OAuth](#public-with-oauth) below).

## Variables

`rostok stack add caldav-mcp` asks for these and writes them to the server's
`.env`. The stack builds its image from the `Dockerfile` next to
`compose.yml`. Its Traefik route is off unless the server opts in (below), so
an internal server needs no domain. It needs the `traefik` stack for the `proxy` network.

| Key                     | Default           | Meaning                            |
| ----------------------- | ----------------- | ---------------------------------- |
| `CALDAV_MCP_SERVER_URL` | required          | CalDAV server URL                  |
| `CALDAV_MCP_USERNAME`   | required          | CalDAV username                    |
| `CALDAV_MCP_PASSWORD`   | required, secret  | CalDAV password                    |
| `CALDAV_MCP_TOKEN`      | generated, secret | Bearer token for the HTTP endpoint |

A public OAuth-only server clears `CALDAV_MCP_TOKEN` (below).

Optional, for [Public with OAuth](#public-with-oauth), set by hand in the server's `.env`:

| Key                                 | Default                                  | Meaning                                |
| ----------------------------------- | ---------------------------------------- | -------------------------------------- |
| `CALDAV_MCP_PUBLIC`                 | `false`                                  | `true` turns the Traefik route on      |
| `CALDAV_MCP_DOMAIN`                 | `mcp.${DOMAIN}`                          | Public host name                       |
| `CALDAV_MCP_MIDDLEWARES`            | `security-headers@file,robots-deny@file` | Traefik middlewares                    |
| `CALDAV_MCP_TRUSTED_PROXIES`        | empty                                    | Traefik's address as `<ip>/32`, limits |
| `CALDAV_MCP_PUBLIC_URL`             | empty                                    | `https://<domain>`, no path            |
| `CALDAV_MCP_OWNER_PASSWORD_HASH`    | empty, secret                            | The owner password hash                |
| `CALDAV_MCP_AUTH_PEPPER`            | empty, secret                            | The pepper the hash was made with      |
| `CALDAV_MCP_ALLOW_TOKEN_WITH_OAUTH` | `false`                                  | `true` accepts the token next to OAuth |

For Stalwart on `mail.${DOMAIN}`, the URL is `https://mail.${DOMAIN}/dav/cal/`.
The username is the full mailbox address (e.g. `you@example.com`).

## Public with OAuth

caldav-mcp serves an OAuth authorization server when `PUBLIC_URL`, `OWNER_PASSWORD_HASH` and
`AUTH_PEPPER` are all set (its README, "Use it from claude.ai"). Only the owner can approve a
connector: the consent page asks for the owner password. Grants live in Deno KV at
`${VOLUMES_PATH}/caldav-mcp/oauth.kv`, so connectors stay signed in across redeploys.

With OAuth on, caldav-mcp (v1.2.0 and later) refuses the bearer token and answers it like any wrong
token, so a leaked token does not open the public endpoint. Leave `CALDAV_MCP_TOKEN` empty on a
public server. A server that must serve Open WebUI and claude.ai from one copy sets
`CALDAV_MCP_ALLOW_TOKEN_WITH_OAUTH=true`. Safer is a second, internal copy on the server that runs
Open WebUI, with `CALDAV_MCP_PUBLIC=false` and the token set.

There is no backup: losing the store only means signing connectors in again.

Set all three OAuth values or none. `CALDAV_MCP_PUBLIC=true` without them publishes a bearer-only
endpoint, which caldav-mcp still protects but claude.ai cannot use.

The image builds the caldav-mcp tag in `CALDAV_MCP_VERSION` (`Dockerfile`) and fails if the tag
no longer points at `CALDAV_MCP_COMMIT`. Its dependencies come from `caldav-mcp.lock`, with
`--frozen`. To upgrade, change the tag and the commit together and regenerate the lockfile as the
`Dockerfile` describes; a branch would let Docker's build cache keep an old clone.

The binary runs as `PUID:PGID` with no capabilities and a read-only root file system. Its Deno
permissions are fixed at build time: it listens on port 3000, reaches only the host of
`CALDAV_MCP_SERVER_URL` and `claude.ai`, and reads and writes only `/data`. A new CalDAV host needs
a rebuild, which `deno task deploy` does. Images before spy4x/rostok#356 ran as root and left
`oauth.kv` owned by root. `deno task deploy` chowns the volume only when the folder itself is
missing or has the wrong owner, and that folder is already `PUID:PGID`, so the deploy skips it.
When upgrading from such an image, stop the container, back up `oauth.kv*`, and chown those files to
`PUID:PGID` once (`sudo -n chown PUID:PGID ${VOLUMES_PATH}/caldav-mcp/oauth.kv*`), or the store will
not open and the container restarts in a loop.

1. Pick a long random owner password and a pepper of at least 32 characters
   (`openssl rand -base64 48`), then hash the password in a caldav-mcp checkout with caldav-mcp's
   README, "Make the owner password hash": `AUTH_PEPPER` in the environment,
   `deno task password:hash`, password on stdin. Neither value reaches argv or shell history.
2. In the server's `.env` (mode 0600 on the server, encrypted in `.env.age`), single-quoting the
   two secrets so a `$` in them survives Compose interpolation:

   ```env
   CALDAV_MCP_PUBLIC=true
   CALDAV_MCP_TOKEN=
   CALDAV_MCP_PUBLIC_URL=https://mcp.example.com
   CALDAV_MCP_OWNER_PASSWORD_HASH='<pbkdf2-sha256 hash>'
   CALDAV_MCP_AUTH_PEPPER='<pepper>'
   TRAEFIK_PROXY_IP=<ip>
   CALDAV_MCP_TRUSTED_PROXIES=<ip>/32
   ```

   `TRAEFIK_PROXY_IP` gives Traefik a fixed address on `proxy` (see the traefik stack's README):
   an unused address inside what this prints on the server,
   `docker network inspect proxy --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}'`, such as
   the last one. Only that address may then set `X-Forwarded-For`, which decides the client
   address for the per-client rate limit and, from caldav-mcp v1.3.0, for the owner-password
   lockout too (10 wrong passwords per address in 15 minutes, 100 from all addresses in a day).
   Trusting the whole subnet would let any container on `proxy` forge that address.

3. Then `deno task env:encrypt`.
4. Point the DNS name at the server, then `deno task deploy <server> traefik` (for the new
   address) and `deno task deploy <server> caldav-mcp`.
5. In claude.ai, Settings → Connectors → Add custom connector, URL `https://mcp.example.com/mcp`,
   then sign in with the owner password.

### Sign a connector out

From caldav-mcp v1.3.0 each grant ends 90 days after approval, and the owner can revoke one while
the server runs, for example after losing a phone that had Claude signed in:

```bash
ssh <server> docker exec hl-caldav-mcp caldav-mcp grants list           # id, client, start, end
ssh <server> docker exec hl-caldav-mcp caldav-mcp grants revoke <grantId>
```

`revoke` signs out that connector only; the others stay signed in. A connector approved before
v1.3.0 shows up in the list only after its next token refresh. To sign everything out at once,
delete `oauth.kv` and its `-shm` and `-wal` files while the container is stopped; every connector
then asks for the owner password. A login shell may not have `VOLUMES_PATH`, so ask Docker for the
volume path. On the server:

```bash
DATA="$(docker inspect hl-caldav-mcp --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')"
test -n "$DATA" && docker stop hl-caldav-mcp && {
  docker run --rm -u 0:0 -v "$DATA:/data:z" --entrypoint rm denoland/deno:alpine-2.9.7 \
    -f /data/oauth.kv /data/oauth.kv-shm /data/oauth.kv-wal
  docker start hl-caldav-mcp
}
```

### Let the owner in during a lockout

From caldav-mcp v1.3.0, after 100 wrong owner passwords from all addresses within a day, every
approval answers `429`, the right password included, until the day has passed. Anyone who reaches
the server can keep that going for as long as they keep sending wrong passwords, and a restart does
not end it, because the count lives in `oauth.kv`. Connectors that are already signed in keep
working; only new approvals are refused.

To let the owner approve again, block the sending addresses first, then delete the server-wide
count, the key `["mcp-oauth", "attempts", "total"]`. The runtime image has no `deno`, so run the
builder image against the volume while the container is stopped. On the server:

```bash
DATA="$(docker inspect hl-caldav-mcp --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')"
test -n "$DATA" && docker stop hl-caldav-mcp && {
  docker run --rm -u 0:0 -v "$DATA:/data:z" denoland/deno:alpine-2.9.7 eval --unstable-kv \
    'const kv = await Deno.openKv("/data/oauth.kv"); await kv.delete(["mcp-oauth", "attempts", "total"]); kv.close()'
  docker start hl-caldav-mcp
}
```

It deletes that one key: grants, tokens and the per-address counts stay. The container starts again
even when the delete fails; check with `docker ps` that `hl-caldav-mcp` is running. Approve within the next
few minutes, before new wrong passwords reach the limit again.

## OpenCode MCP setup

OpenCode config (`~/.config/opencode/opencode.json`) registers this server
under `mcp.caldav-mcp` with `type: "local"` — it spawns a script and speaks
MCP over stdin/stdout. The script lives in the Syncthing-only `mcps/`
dir (per AGENTS.md "never commit plaintext credentials" rule). All local
MCP launchers share this layout — one subdir per MCP, one `.env` + one
launcher script:

```
~/sync/code/mcps/
└── caldav/
    ├── .env         # CALDAV_MCP_SERVER_URL/USERNAME/PASSWORD (synced, not git)
    └── start.sh     # launcher: sources env, execs `deno run -A main.ts`
```

**Why a local script and not just the Docker HTTP endpoint?** OpenCode's
`type: "local"` MCP runs a child process and talks stdio. Reusing the Docker
HTTP endpoint would require a `type: "remote"` config and a different auth
header, which is more setup than launching the binary locally.

**Why `deno run` and not the compiled binary?** The source syncs via
Syncthing, so updates take effect immediately. The compiled binary at
`~/sync/code/caldav-mcp/caldav-mcp` is machine-specific (native ELF) and
must be rebuilt per source change — a footgun that bit us in Aug 2026 when
the stale binary produced double-prefixed URLs (`/dav/cal/dav/cal/...`) on
Stalwart because it predated the non-root-path fix (`7db310f`).

**Bootstrap on a fresh machine:**

```bash
# 1. Clone the source
git clone https://github.com/spy4x/caldav-mcp ~/sync/code/caldav-mcp

# 2. Create the local MCP launcher dir + .env
mkdir -p ~/sync/code/mcps/caldav
# Copy the launcher from another machine's synced copy (or write it per
# stacks/caldav-mcp/README.md pattern), then edit .env with your creds.

# 3. Restart opencode-web to pick up the new MCP
systemctl --user restart opencode-web
```

## Resources

- [CalDAV MCP Source](https://github.com/spy4x/caldav-mcp)
- [MCP Protocol](https://modelcontextprotocol.io/)
- [Stalwart CalDAV migration](../../docs/migrate-radicale-to-stalwart.md)
