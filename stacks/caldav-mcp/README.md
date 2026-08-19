# caldav-mcp

CalDAV MCP server providing calendar/todo access to AI assistants.

## Features

- Exposes CalDAV calendars/todos as MCP tools
- Native Deno implementation, zero npm dependencies
- Direct CalDAV protocol with proper VTODO/VEVENT support
- Used by OpenCode AI for calendar operations

## Access

Internal MCP server — no external web UI. Two access modes:

1. **Docker HTTP (default)** — reachable inside Docker network at `hl-caldav-mcp:3000`
   (used by OpenWebUI, n8n, anything that can do HTTP).
2. **Local stdio** — for OpenCode running on the host. Launched via a script in
   `~/sync/code/mcps/caldav/start.sh` (see [OpenCode MCP setup](#opencode-mcp-setup) below).

## Configuration

```bash
CALDAV_URL=<caldav-server-url>      # or CALDAV_SERVER_URL
CALDAV_USERNAME=<username>
CALDAV_PASSWORD=<password>
```

For Stalwart on `mail.${DOMAIN}`, the URL is `https://mail.${DOMAIN}/dav/cal/`.
The username is the full mailbox email (e.g. `anton@antonshubin.com`).

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
    ├── .env         # CALDAV_SERVER_URL/USERNAME/PASSWORD (synced, not git)
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
