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

Optional, for [Public with OAuth](#public-with-oauth), set by hand in the server's `.env`:

| Key                              | Default                                  | Meaning                                  |
| -------------------------------- | ---------------------------------------- | ---------------------------------------- |
| `CALDAV_MCP_PUBLIC`              | `false`                                  | `true` turns the Traefik route on        |
| `CALDAV_MCP_DOMAIN`              | `mcp.${DOMAIN}`                          | Public host name                         |
| `CALDAV_MCP_MIDDLEWARES`         | `security-headers@file,robots-deny@file` | Traefik middlewares                      |
| `CALDAV_MCP_TRUSTED_PROXIES`     | empty                                    | The `proxy` network's subnet, for limits |
| `CALDAV_MCP_PUBLIC_URL`          | empty                                    | `https://<domain>`, no path              |
| `CALDAV_MCP_OWNER_PASSWORD_HASH` | empty, secret                            | The owner password hash                  |
| `CALDAV_MCP_AUTH_PEPPER`         | empty, secret                            | The pepper the hash was made with        |

For Stalwart on `mail.${DOMAIN}`, the URL is `https://mail.${DOMAIN}/dav/cal/`.
The username is the full mailbox address (e.g. `you@example.com`).

## Public with OAuth

caldav-mcp serves an OAuth authorization server when `PUBLIC_URL`, `OWNER_PASSWORD_HASH` and
`AUTH_PEPPER` are all set (its README, "Use it from claude.ai"). Only the owner can approve a
connector: the consent page asks for the owner password. Grants live in Deno KV at
`${VOLUMES_PATH}/caldav-mcp/oauth.kv`, so connectors stay signed in across redeploys. The
bearer token keeps working alongside OAuth.

There is no backup: losing the store only means signing connectors in again.

Set all three OAuth values or none. `CALDAV_MCP_PUBLIC=true` without them publishes a bearer-only
endpoint, which caldav-mcp still protects but claude.ai cannot use.

The image builds the caldav-mcp tag in `CALDAV_MCP_VERSION` (`Dockerfile`). Bump it there to
upgrade; a branch would let Docker's build cache keep an old clone.

1. Pick a long random owner password and a pepper of at least 32 characters
   (`openssl rand -base64 48`), then hash the password in a caldav-mcp checkout with caldav-mcp's
   README, "Make the owner password hash": `AUTH_PEPPER` in the environment,
   `deno task password:hash`, password on stdin. Neither value reaches argv or shell history.
2. In the server's `.env` (mode 0600 on the server, encrypted in `.env.age`), single-quoting the
   two secrets so a `$` in them survives Compose interpolation:

   ```env
   CALDAV_MCP_PUBLIC=true
   CALDAV_MCP_PUBLIC_URL=https://mcp.example.com
   CALDAV_MCP_OWNER_PASSWORD_HASH='<pbkdf2-sha256 hash>'
   CALDAV_MCP_AUTH_PEPPER='<pepper>'
   CALDAV_MCP_TRUSTED_PROXIES=<subnet>
   ```

   The subnet is what this prints on the server:
   `docker network inspect proxy --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}'`.
   It trusts every container on `proxy` to set `X-Forwarded-For`; that only affects the per-client
   rate limit, not the owner-password lockout, which is server-wide.

3. Then `deno task env:encrypt`.
4. Point the DNS name at the server, then `deno task deploy <server> caldav-mcp`.
5. In claude.ai, Settings → Connectors → Add custom connector, URL `https://mcp.example.com/mcp`,
   then sign in with the owner password.

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
