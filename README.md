# rostok

**росток** (sprout) — scaffold a self-hosted homelab from a curated catalog.

`rostok` is a CLI plus a catalog of self-hosted services. One command
and a few questions get you from a fresh folder to a deployable
infrastructure-as-code repo for your servers.

## Who it's for

| Persona                                             | What you get                                                  |
| --------------------------------------------------- | ------------------------------------------------------------- |
| **Hobbyist** — one old PC, want a few services      | One-command onboarding, sensible defaults, no jargon          |
| **Multi-server homelabber** — 3 boxes, 20+ services | Cross-server wiring, dependency graph, multi-server config    |
| **Small company** — replace SaaS with self-hosted   | SSO, backups, monitoring baked in; sensible security defaults |

Big companies are out of scope. The repo stays small and homelab-shaped.

## Install

```bash
deno install -A -n rostok jsr:@rostok/cli
```

Requires [Deno](https://deno.land) ≥ 2.0. `age` is optional but
endorsed — the wizard runs to completion without it, and your `.env`
files stay plaintext (gitignored). Install `age` to enable encrypted
`.env.age` files you can safely commit (the wizard offers to set this
up for you).

## Quick start

```bash
mkdir ~/rostok && cd ~/rostok
rostok                       # wizard: init → server create → stack add
rostok stack list            # browse the bundled catalog
rostok deploy home           # deploy what you configured
```

The wizard writes `deno.jsonc`, initialises git, and creates
`servers/<name>/` with your chosen stack. Every `.env` mutation is
auto-encrypted to `.env.age` (when `age` is installed), so secrets are
safe to commit.

## Commands

| Command                                      | What it does                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| `rostok`                                     | Onboarding wizard: init + server create + stack add                              |
| `rostok server create [<name>]`              | Create a server (one of the wizard steps, standalone)                            |
| `rostok stack add <name> --server=<name>`    | Add a stack to a server from the bundled catalog                                 |
| `rostok stack list [--tree] [--format json]` | Browse the catalog. `--tree` indents under category, `--format json` for scripts |
| `rostok deploy <server> [stack]`             | Deploy — thin wrapper over `deno task deploy`                                    |
| `rostok env encrypt`                         | Encrypt `.env` → `.env.age` (per-stack + root)                                   |
| `rostok env decrypt`                         | Decrypt `.env.age` → `.env`                                                      |
| `rostok env status`                          | Encryption posture + next steps                                                  |
| `rostok env setup`                           | Generate `.age/key.txt` — `rostok` hides `age-keygen` from you                   |
| `rostok --help`, `rostok --version`          | Self-explanatory                                                                 |

Flags:

| Flag                      | Meaning                                                                          |
| ------------------------- | -------------------------------------------------------------------------------- |
| `-n`, `--non-interactive` | Skip prompts, use defaults (every required var must have a default or a `--var`) |
| `--server=<name>`         | Target server for `stack add` (`deploy` takes the server as a positional arg)    |
| `--var KEY=VAL`           | Repeatable. Overrides one variable for the current command                       |

## What you get

After `$ rostok`, your project folder holds:

```
.
├── deno.jsonc              # imports map for @rostok/cli
├── .gitignore              # ignores plaintext .env / .env.root
├── .env.root               # CLI-managed cross-server vars (gitignored)
├── .env.root.age           # encrypted — safe to commit
└── servers/
    └── home/
        ├── config.json     # which stacks (CLI-managed, committed)
        ├── .env            # per-server vars (gitignored)
        ├── .env.age        # encrypted — safe to commit
        └── README.md
```

Full layout + ownership rules: [`docs/design/v1-cli.md`](docs/design/v1-cli.md).

## How it works

```
┌──────────────┐        ┌────────────────────┐
│ rostok CLI   │───────▶│ stacks/ catalog    │
│  (JSR)       │        │  (compose, backup, │
│              │        │   +meta.ts)        │
└──────────────┘        └────────────────────┘
        │                         │
        ▼                         ▼
    your project:           your platform:
    deno.jsonc              Docker host
    servers/<n>/.env        (Traefik, gatus, …)
    servers/<n>/config.json
```

The CLI ships with the catalog bundled. Your project folder is a plain
Git repo with `servers/<name>/` for each machine. Each `stacks/<name>/+meta.ts`
declares its variables; the CLI prompts for them, writes `.env`, and
re-encrypts `.env.age` after every mutation.

## Documentation

- [Concepts](docs/usage/concepts.md) — what a _stack_, _server_, _wizard_ are
- [Architecture](docs/usage/architecture.md) — how the catalog, CLI, and your project fit together
- [Catalog](docs/usage/catalog.md) — what's in the catalog
- [ENCRYPTED_ENV_FILES](docs/usage/ENCRYPTED_ENV_FILES.md) — age64 workflow
- [Disaster recovery](docs/usage/disaster-recovery.md) — backup, restore, spin up a new server
- [v1 design](docs/design/v1-cli.md) — ready-to-implement
- [v2 backlog](docs/design/v2-cli.md) — draft
- [v2 static website](docs/design/v2-website.md) — draft

Full index: [`docs/README.md`](docs/README.md).

## Contributing

See [`docs/contributing/contributing.md`](docs/contributing/contributing.md).
New stacks are welcome — open a PR with a `stacks/<name>/+meta.ts`
plus the usual `compose.yml`, `backup.ts`, `README.md`. See
[`docs/contributing/adding-services.md`](docs/contributing/adding-services.md)
for the schema.

## License

[MIT](LICENSE).
