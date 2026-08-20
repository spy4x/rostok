# rostok

**росток** (sprout) — scaffold a self-hosted homelab from a curated catalog.

`rostok` is a CLI + a catalog of self-hosted services. One command and
a few questions get you from a fresh folder to a deployable
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

Requires [Deno](https://deno.land) ≥ 2.0 and `age` on PATH.

## Quick start

```bash
mkdir ~/homelab && cd ~/homelab
rostok                       # wizard: init, server, stack
rostok stack list            # browse the catalog
rostok deploy home           # deploy what you configured
```

The wizard writes `deno.jsonc`, init git, and creates `servers/<name>/`
with your chosen stack. Every `.env` mutation is auto-encrypted to
`.env.age` so it's safe to commit.

## What's in the catalog

See [`docs/catalog.md`](docs/catalog.md) for the full list with
descriptions. Categories include:

- **Proxy & TLS** — Traefik, Cloudflared
- **Auth** — Authelia (SSO)
- **Monitoring** — Gatus (health), Ntfy (alerts)
- **Data** — Vaultwarden (passwords), Immich (photos), Jellyfin (media)
- **Dev** — Gitea (git), Woodpecker (CI)
- **Productivity** — Paperless, Stirling-PDF, HedgeDoc
- **Smart-home** — Home Assistant

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

The CLI ships with the catalog bundled. Your project folder is a
plain Git repo with `servers/<name>/` for each machine. `+meta.ts` files
in the catalog declare variables; the CLI prompts for them, writes
`.env`, and re-encrypts `.env.age`.

Full design: [`docs/v1-cli.md`](docs/v1-cli.md). Concepts:
[`docs/concepts.md`](docs/concepts.md). Architecture:
[`docs/architecture.md`](docs/architecture.md).

## Documentation

- [Quickstart (above)](#quick-start)
- [`docs/concepts.md`](docs/concepts.md) — stack, server, wizard
- [`docs/architecture.md`](docs/architecture.md) — how the pieces fit
- [`docs/catalog.md`](docs/catalog.md) — what's in the catalog
- [`docs/adding-services.md`](docs/adding-services.md) — author a stack
- [`docs/ENCRYPTED_ENV_FILES.md`](docs/ENCRYPTED_ENV_FILES.md) — age64 workflow
- [`docs/v1-cli.md`](docs/v1-cli.md) — v1 design (ready-to-implement)
- [`docs/v2-cli.md`](docs/v2-cli.md) — v2 backlog (draft)
- [`docs/v2-website.md`](docs/v2-website.md) — future static site (draft)

## Contributing

See [`docs/contributing.md`](docs/contributing.md). New stacks are
welcome — open a PR with a `stacks/<name>/+meta.ts` plus the usual
compose, backup, README. See `docs/adding-services.md` for the schema.

## License

[MIT](LICENSE).
