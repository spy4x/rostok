# Architecture

`rostok` is a **catalog** plus a **CLI tool**. The catalog is a tree of
self-hosted services. The CLI scaffolds a user's project, prompts for
the values each stack needs, and re-encrypts the secrets for git.

## Pieces

```
┌─────────────────────────────────────────────────────────────┐
│                  github.com/spy4x/rostok                    │
│                                                             │
│  ┌──────────────┐   ┌─────────────────────────────────┐     │
│  │  stacks/     │   │  cli/  (the rostok CLI source)  │     │
│  │              │   │                                 │     │
│  │  traefik/    │   │  cli/+main.ts                   │     │
│  │  gatus/      │   │  cli/server-create.ts           │     │
│  │  vaultwarden/│   │  cli/stack-add.ts               │     │
│  │  ... (50+)   │   │  cli/stack-list.ts              │     │
│  │              │   │  cli/stack-meta.ts              │     │
│  │  +meta.ts    │   │  cli/secrets.ts                 │     │
│  │  compose.yml │   │  cli/wizard.ts                  │     │
│  │  backup.ts   │   │                                 │     │
│  │  README.md   │   │  depends on:                    │     │
│  └──────────────┘   │    scripts/encryption/          │     │
│       │             │    scripts/hooks/               │     │
│       │             └─────────────────────────────────┘     │
│       │                        │                            │
│       └────────┬───────────────┘                            │
│                │                                            │
│                ▼  published to JSR                          │
│         ┌──────────────┐                                    │
│         │  @rostok/cli │                                    │
│         │  (binary +   │                                    │
│         │   imports)   │                                    │
│         └──────────────┘                                    │
└────────────────────│────────────────────────────────────────┘
                     │
                     ▼  installed by users
         ┌────────────────────┐
         │  user's machine    │
         │   $ rostok         │
         └─────────┬──────────┘
                   │
                   ▼  scaffolds
         ┌─────────────────────────────────────────┐
         │  user's project folder                  │
         │                                          │
         │  ~/homelab/                              │
         │  ├── deno.jsonc                          │
         │  ├── .gitignore                          │
         │  ├── .env.root         │  ← CLI-managed │
         │  ├── .env.root.age     │  ← gitignored  │
         │  └── servers/                           │
         │      ├── home/                          │
         │      │   ├── config.json                │
         │      │   ├── .env        │  ← CLI-managed│
         │      │   ├── .env.age    │  ← gitignored │
         │      │   └── configs/                   │
         │      └── cloud/                         │
         │          └── ...                        │
         └─────────────────────────────────────────┘
                           │
                           ▼  deploy
                  ┌────────────────────────┐
                  │  user's Docker hosts   │
                  │  (home, cloud, ...)    │
                  └────────────────────────┘
```

## Components

### `stacks/` — the catalog

A flat directory of self-hosted services. One folder per stack. Every
folder is reusable by any user; nothing is hardcoded to a real
domain, IP, or hostname.

Each stack has:

- `compose.yml` — Docker Compose definition
- `backup.ts` — backup config (skipped for stateless services)
- `README.md` — purpose, configuration, troubleshooting
- `+meta.ts` — CLI schema (READY-TO-IMPLEMENT for v1; tracked per
  `docs/v1-cli.md` §4 rollout)

### `cli/` — the rostok CLI source

Deno-native. Uses `@cliffy/command` for parsing and `@cliffy/prompt`
for interactive input. `npm:arktype@^2` for runtime validation.

See `docs/v1-cli.md` for the full source-map and rollout.

### `scripts/encryption/` — age64

Per-value age encryption. Each `KEY=age64:...` line is encrypted
independently. Only changed lines re-encrypt. Avoids the
"re-encrypt everything on every run" problem with SOPS.

### `scripts/hooks/` — git hooks

Installs pre-commit, post-checkout, post-merge hooks that:

- Auto-encrypt `.env` → `.env.age` before commit
- Auto-decrypt `.env.age` → `.env` after checkout/merge

The wizard (`$ rostok`) runs `hooks:install` once during init.

### User's project folder

`rostok` creates a new project folder (or operates in an existing one)
with:

- `deno.jsonc` — imports map for `@rostok/cli`, env file refs
- `.gitignore` — secrets, runtime state
- `.env.root` + `.env.root.age` — project-wide env (CLI-managed)
- `servers/<name>/` — one folder per server, created by
  `rostok server create`
- `servers/<name>/config.json` — which stacks to deploy
- `servers/<name>/.env` + `.env.age` — server env (CLI-managed)
- `servers/<name>/configs/` — per-service overrides (optional)

The user's project folder is a plain Git repo. They commit `*.age`
files; `.env` files stay on disk.

## Data flow

```
1. User runs `rostok`
   └─▶ CLI reads stacks/*/+meta.ts from the JSR-published bundle
   └─▶ Prompts for project name, server name, SSH target, domain
   └─▶ Prompts for stack variables (or uses --var defaults)
   └─▶ Writes deno.jsonc, .env.root, servers/<n>/{config.json,.env}
   └─▶ Triggers env:encrypt → .env.age
   └─▶ Installs git hooks

2. User runs `rostok deploy home`
   └─▶ For each stack in servers/home/config.json:
       - rsync the stack to the remote host
       - docker compose up -d
       - run before.deploy hooks
   └─▶ Run cross-server health checks (Gatus)

3. Git workflow
   └─▶ User commits servers/<n>/.env.age (encrypted)
   └─▶ On another machine, .env.age auto-decrypts to .env
```

## Deploy topology

Each user picks their own topology. A common pattern:

```
   cloud (Hetzner, public IP)            home (Hetzner, private)
   ┌────────────────────────┐           ┌────────────────────────┐
   │  Traefik (public)      │◀── HTTPS ──▶  Traefik (LAN)       │
   │  Authelia (SSO)        │           │  Vaultwarden           │
   │  Gatus (cross-mon)     │           │  Gatus (cross-mon)     │
   │  Stalwart (mail)       │           │  Immich / Jellyfin     │
   │  Ntfy (alerts)         │           │  Gitea / Woodpecker    │
   └────────┬───────────────┘           └────────────┬───────────┘
            │                                        │
            └────────────┐      ┌───────────────────┘
                         ▼      ▼
                   ┌────────────────────┐
                   │  offsite (Hetzner) │
                   │  Restic backups    │
                   │  Syncthing mirror  │
                   └────────────────────┘
```

The catalog is topology-agnostic. The CLI scaffolds whatever the user
asks for.

## Security model

- **Per-value age encryption** — each `KEY=age64:...` encrypted
  independently. `password=age64:abc`, `password_new=age64:xyz`. Only
  the changed line re-encrypts.
- **Key in `.age/key.txt`** — gitignored, restored from Syncthing or a
  password manager across machines.
- **Container prefix `hl-`** — avoids name conflicts with other
  projects on the same Docker host.
- **Auth middleware** — every non-public service uses
  `middlewares=authelia@file` (SSO) or `middlewares=auth` (basic
  auth). Public services have no auth middleware.
- **No secrets in catalog** — values flow from the user's `.env`.

## What this is NOT

- **Not a Kubernetes / Nomad alternative.** Single-host Docker Compose.
- **Not a Terraform / Pulumi alternative.** No state, no plan, no
  apply. Just an opinionated scaffold.
- **Not a multi-tenant SaaS.** Each user runs their own CLI + their
  own project folder.
