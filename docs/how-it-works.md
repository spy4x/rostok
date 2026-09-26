# How it works

How the CLI, the catalog and your project fit together, and who rostok is
built for. For the full layout and ownership rules, see
[`design/v1-cli.md`](design/v1-cli.md); for the moving parts in more depth,
[`usage/architecture.md`](usage/architecture.md).

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

## Who it's for

| Persona                                             | What you get                                                  |
| --------------------------------------------------- | ------------------------------------------------------------- |
| **Hobbyist** — one old PC, want a few services      | One-command onboarding, sensible defaults, no jargon          |
| **Multi-server homelabber** — 3 boxes, 20+ services | Cross-server wiring, dependency graph, multi-server config    |
| **Small company** — replace SaaS with self-hosted   | SSO, backups, monitoring baked in; sensible security defaults |

Big companies are out of scope. The repo stays small and homelab-shaped.

