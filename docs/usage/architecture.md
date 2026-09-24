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
  `docs/design/v1-cli.md` §4 rollout)

### `cli/` — the rostok CLI source

Deno-native. Uses `@cliffy/command` for parsing and `@cliffy/prompt`
for interactive input. `npm:arktype@^2` for runtime validation.

See `docs/design/v1-cli.md` for the full source-map and rollout.

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

## Deploy is the source of truth

What `servers/<name>/` lists is what runs on the server — nothing else.
`rostok deploy` makes the server match the project exactly:

- A full deploy (`rostok deploy <server>`) syncs `PATH_APPS` with
  `rsync --delete`, so a file removed from a stack or from
  `servers/<name>/configs/` disappears from the server on the next
  deploy, and a file that's newer on the server is still overwritten by
  the project's copy. A single-stack deploy
  (`rostok deploy <server> <stack>`) only ever deletes inside that one
  stack's own `PATH_APPS/stacks/<stack>/` directory.
- A stack removed from `config.json` gets its containers stopped
  (`docker compose down --remove-orphans`) and its folder removed, but
  its data is never touched — the stack can be added back later with
  the same data.

**App data must never live inside `PATH_APPS`.** `VOLUMES_PATH` has to
be a sibling directory of `PATH_APPS` (`server create`'s own default:
`/srv/apps` and `/srv/volumes`), never nested inside it or the reverse,
and never equal to it — otherwise the `rsync --delete` above would wipe
it. Deploy refuses a nested `VOLUMES_PATH` outright.

If an existing server has `VOLUMES_PATH` inside `PATH_APPS` (e.g.
`VOLUMES_PATH=${PATH_APPS}/.volumes`), move the data before the next
deploy:

1. Stop the stacks on the server: `docker compose down` in each
   `<PATH_APPS>/stacks/<name>` directory.
2. Move the data folder on the server to a sibling of `PATH_APPS`:
   `mv <old VOLUMES_PATH> <new VOLUMES_PATH>` (the real, expanded
   paths — not the `${...}` form).
3. Set `VOLUMES_PATH` to the new path in `servers/<name>/.env` and
   re-encrypt: `deno task env:encrypt`.
4. Redeploy.

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
