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
  and deploy to a remote server via SSH (`SSH_ADDRESS`).
