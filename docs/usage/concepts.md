# Concepts

The vocabulary of `rostok`. Three terms you'll see in every doc.

## Stack

A **stack** is one self-hosted service the user can run. Examples:
Traefik, Vaultwarden, Gatus, Jellyfin, Immich.

In the repo, a stack lives at `stacks/<name>/` and contains:

- `compose.yml` — the Docker Compose definition
- `backup.ts` — what to back up (skipped for stateless stacks)
- `README.md` — the human-readable description
- `+meta.ts` — the schema the CLI uses to prompt for variables
  (added in v1)

A stack is **generic**. No hardcoded domains, IPs, or secrets. Any
user can take any stack and deploy it on their own server.

The CLI ships with the catalog bundled. Users see it via
`rostok stack list`. Power users can extract the catalog and modify
their own copy (v2 feature).

## Server

A **server** is one of the user's machines. Could be a Hetzner VM, a
Raspberry Pi, an old PC, anything that runs Docker.

In the user's project folder:

```
servers/<name>/
├── config.json         # which stacks from the catalog to deploy
├── .env                # CLI-managed env vars (gitignored)
├── .env.age            # age64-encrypted (gitignored)
├── configs/            # per-service overrides (optional)
└── README.md           # server-specific notes
```

A user can have many servers. Each picks its own subset of stacks from
the catalog. The cross-server convention: each server's Gatus monitors
services on the *opposite* server (so a single box going down doesn't
hide the alert).

### A server on the machine rostok runs on

Set `SSH_ADDRESS=local` when the server is the machine you run `rostok`
on, for example a laptop with no ssh server:

```
rostok server create laptop -n --var SSH_ADDRESS=local \
  --var DOMAIN=example.com --var CONTACT_EMAIL=a@example.com
```

The value lives in the server's `.env`, so every later `rostok deploy
laptop` deploys locally without a flag. What changes:

- `server create` reads the docker group, uid, gid, user name and time
  zone from this machine instead of over ssh.
- `rostok deploy` runs every step as a local process: the docker and
  sudo checks, stale-stack cleanup, volume setup (still through
  `sudo -n` when you are not root), `docker compose up`, and a plain
  local `rsync` into `PATH_APPS` with the same flags as a remote deploy.
  ssh is never started.
- Stack hooks get `SSH_ADDRESS=local` and no `SSH_HOST` or `SSH_PORT`.
  syncthing's hook then runs its commands locally. The after-deploy
  hooks of traefik, gatus, caldiy, open-webui and stalwart still need
  `SSH_HOST` and fail on a local server for now
  ([#287](https://github.com/spy4x/rostok/issues/287)).
- Each local step runs with a reduced environment: `PATH`, `HOME`,
  `USER`, `LOGNAME`, `LANG`, `LC_*`, `XDG_RUNTIME_DIR` and the
  `DOCKER_CONFIG` / `DOCKER_HOST` / `DOCKER_CONTEXT` variables. Anything
  else exported in your shell (a `DOMAIN`, say) never overrides the
  server's `.env`.
- Deploy refuses to start when Docker points anywhere but a local unix
  socket: `DOCKER_HOST=tcp://…` or `ssh://…`, or a context chosen with
  `docker context use`. Run `docker context use default` first.
- Deploy refuses a `PATH_APPS` or `VOLUMES_PATH` that is, contains or
  sits inside the project folder, and a `PATH_APPS` that is your home
  folder or one of its parents: the sync's `rsync --delete` would erase
  them.

Only the exact, lower-case word `local` does this. `localhost`,
`127.0.0.1`, `root@local` or `local:22` stay ordinary ssh targets, so a
VM reached through a forwarded port keeps working. An ssh_config alias
named exactly `local` can no longer be reached; rename the alias.

## Wizard

The **wizard** is the no-args command `$ rostok`. It runs three steps
in sequence:

1. **Init** — scaffold the project folder (idempotent)
2. **Server create** — one server with its connection details
3. **Stack add** — pick one stack from the catalog, fill its variables

After the wizard, the user has a deployable project. Subsequent
`$ rostok stack add <name> --server=<name>` calls add more stacks to
existing servers.

The wizard is what new users run. Power users write their own
`config.json` and use the subcommands directly.

## Other terms

- **Catalog** — the `stacks/` directory. The full set of stacks the CLI
  ships with.
- **Project** — the user's local folder containing `deno.jsonc`,
  `servers/`, `.env.root`, and `servers/<name>/` entries.
- **Bundle** — a curated subset of stacks (e.g., `tiny` for "small
  homelab"). Pre-defined combinations users can pick instead of
  assembling one stack at a time. (v2 feature.)
- **Variable** — a placeholder in the stack's `compose.yml` of the
  form `${VAR}`. The CLI prompts the user for the value, writes it to
  `.env`, and Traefik/Docker picks it up at deploy time.
- **Secret** — a variable with `secret: true`. Never echoed, never
  logged, encrypted via age64 on every commit.
- **Routing domain** — the `${DOMAIN}` the user picks during server
  create. Every Traefik host rule uses `<subdomain>.${DOMAIN}`.
- **Container prefix** — `hl-`. Every container, Traefik router, and
  Traefik service uses the prefix to avoid name conflicts with other
  projects on the same host.

## What a server *isn't*

- **Not a Kubernetes pod.** One server = one Docker host.
- **Not a multi-tenant cluster.** Each server belongs to one user.
- **Not a remote-only thing.** The wizard can run on the user's laptop
  and deploy to a remote server via SSH (`SSH_ADDRESS`), or deploy to
  itself with `SSH_ADDRESS=local`.
