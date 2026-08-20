# rostok — design

**Status:** draft, awaiting review.
**Goal:** design document for the `rostok` CLI tool that scaffolds a
self-hosted homelab from a shared catalog of services.

Russian "росток" = sprout, seedling. A tiny shoot that grows into a full
homelab. The CLI plants it from the catalog.

This document is reviewed before any implementation begins. The rollout
phases at the bottom correspond to ordered PRs.

---

## 1. Vision

`rostok` turns the `stacks/` catalog of this repository into a working
per-user homelab through a small, opinionated CLI. The same tool works
for three personas:

| Persona | What they get |
|---|---|
| **Hobbyist** — old PC, wants a few services | Sensible defaults, single command onboarding, no jargon |
| **Multi-server homelabber** — 3 boxes, 20+ services | Cross-server wiring (Traefik ↔ Authelia, Gatus cross-monitoring), dependency graph |
| **Small company** — replaces SaaS with self-hosted | SSO, backups, monitoring baked in; sensible security defaults |

Big companies are intentionally out of scope. The repo stays small and
homelab-shaped; production k8s/enterprise tooling serves them better.

The README carries an explicit table covering all three groups so each
reader knows the tool is for them.

---

## 2. Repository strategy

- Rename `spy4x/homelab` → `spy4x/rostok`. GitHub redirect keeps old
  links alive.
- The catalog stays where it is (`stacks/`, `servers/demo/`). Public
  users fork the repo and run `rostok` from inside.
- CLI lives at `cli/+main.ts`, exposed via `deno task rostok`.
- License: MIT (matches existing repo).

A future v2 may split the catalog into a separate repo
(`spy4x/rostok-catalog`) with the CLI consuming it remotely. v1 keeps
catalog + CLI together for simplicity.

---

## 3. CLI commands — v1 surface

```
rostok                                    # top-level help
rostok --version
rostok --help

rostok server create [<name>]             # TUI or non-interactive; scaffolds servers/<name>/
rostok stack add <name> --server=<name>   # adds one stack to an existing server
rostok stack list [--tree] [--server=<n>] # browse catalog, deps graph
rostok deploy <server> [stack]            # wraps `deno task deploy`

# future / deferred to v2+ — listed in docs/cli.md
```

### Non-interactive flags

- `--non-interactive` / `--yes` / `-y` — skip prompts, use defaults
- `--server=<name>` — target server
- `--stacks=<csv>` — for `server create`
- `--var KEY=VAL` — repeatable, overrides a single variable

### Strict-default policy

Every `required: true` variable in `+meta.ts` MUST have either a
`default` value or a `--var KEY=VAL` flag on the command line. Missing
both → command fails with the exact flag syntax. This guarantees
non-interactive mode never hangs and is automation-friendly.

---

## 4. Stack schema — `stacks/<name>/+meta.ts`

```typescript
import type { StackMeta } from "../../cli/stack-meta.ts"
import { generatePassword } from "../../cli/secrets.ts"

export default {
  name: "traefik",
  description: "Reverse proxy with auto-TLS via Let's Encrypt",
  category: "proxy",
  defaults: { IMAGE_TAG: "3.5" },                 // optional compose overrides
  variables: [
    {
      key: "DOMAIN",
      question: "Primary domain for this server?",
      default: "${SERVER_DOMAIN}",                // resolved from server-level vars
      required: true,
    },
    {
      key: "BASIC_AUTH_USER",
      question: "Traefik basic-auth username?",
      default: "admin",
      required: true,
    },
    {
      key: "BASIC_AUTH_PASSWORD",
      question: "Traefik basic-auth password?",
      default: () => generatePassword(24),
      required: true,
      secret: true,
    },
  ],
  // Cross-stack wiring — see §6.
  connectsTo: [],
} satisfies StackMeta
```

### Default resolution

Server-level vars are resolved first (name, domain, SSH target, …).
Then stack vars can reference them via `${SERVER_DOMAIN}`,
`${SERVER_NAME}`. Chain stops there — no nested stack-level references
in v1.

### Secrets

- `secret: true` → never echoed, never logged
- `default: () => generatePassword(N)` — `crypto.getRandomValues`, base64,
  not `Math.random`
- Routed through age64 encryption automatically when `env:encrypt` runs

---

## 5. Generated artifacts

`rostok server create home --stacks=traefik,gatus,vaultwarden` produces:

```
servers/home/
├── config.json                 # which stacks (CLI-managed)
├── .env                        # merged stack vars (CLI-managed keys)
├── .env.age                    # age64-encrypted (gitignored)
├── .env.example                # public template (gitignored outside demo/)
├── configs/                    # per-service overrides, patched by connections
└── README.md                   # server-specific notes
```

`config.json` shape is unchanged from current repo.

---

## 6. Cross-stack wiring

**Adjacency-list on the stack** — the dependent stack declares its
outgoing patches.

```typescript
// stacks/vaultwarden/+meta.ts
connectsTo: [
  {
    stack: "traefik",
    when: (ctx) => ctx.serverHasStack("traefik"),
    setup: async (ctx) => {
      // patch vaultwarden's compose.yml to add Traefik labels,
      // and add a router rule to servers/<n>/configs/traefik/dynamic/
    },
  },
],
```

Why one direction: each stack owns its outgoing edges. No N×M files.
If both directions are needed (rare), each stack declares its own
outgoing adjacency.

### Resolution order

1. Server-level vars resolved
2. All target stacks loaded; `+meta.ts` validated
3. Topsort stacks by `dependencies` (declared in `+meta.ts`)
4. For each stack in order, run its `connectsTo[*].setup()` against the
   already-resolved artifacts of peer stacks

### Why not `stacks/<A>/connections/<B>.ts/`

User-proposed alternative. Rejected for v1 because:

- N×M file count grows fast (6 stacks = up to 30 connection files)
- Patch logic belongs with the stack that depends on it, not as a
  sibling
- Harder to grep ("where does vaultwarden get configured?")

If complexity demands it later, we can add a `connections/` dir for
cross-cutting patches that don't belong to any one stack.

---

## 7. `.env` ownership

The list of `variables[].key` in `+meta.ts` IS the ownership list. No
extra manifest file.

When CLI writes `servers/<n>/.env`:
- Keys declared by stack X → written/updated by stack X's setup
- Keys not declared by any stack → preserved untouched
- Hand-edits to declared keys → preserved on `--var` only if explicit

Rationale: keeps the schema self-describing; no parallel metadata to
keep in sync. Tradeoff: a hand-edit to a CLI-managed key gets clobbered
on next `stack add`. This is acceptable because:
- CLI-managed keys are always overridable via `--var`
- A clear log line tells the user which keys the CLI is about to write

---

## 8. Distribution

Multiple paths, all supported in v1:

1. `deno task rostok` from a cloned repo (zero install)
2. `deno install -A -n rostok jsr:@rostok/cli` (JSR — primary)
3. `npx rostok` / `bunx rostok` via npm tarball (compat)
4. Compiled binaries from GH Releases — v2, after the API stabilises

JSR is the primary distribution because Deno-native, semver-clean, no
publish-time surprises.

---

## 9. Documentation

### v1

- `README.md` — rewritten. Personas table, quickstart, command
  reference, link to docs/cli.md
- `docs/cli.md` — full CLI reference, command surface, `+meta.ts`
  schema reference, examples. Also serves as the **backlog of v2+
  commands and ideas** that didn't make v1
- `docs/website.md` — placeholder. Captures the future-static-site
  idea (single source of truth, no duplication between docs and site
  code). No implementation in v1.

### v2+ (future)

- Static website generated from sources. All docs live in `README.md`
  and `docs/*.md`. The site is a thin renderer that consumes the same
  markdown. No hardcoded copy in the site. Tooling: probably
  `fresh/2` or `astro` — decide when we get there.
- Captured in `docs/website.md`.

---

## 10. Testing

- `cli/stack-meta.test.ts` — schema validation, default resolution
  (`${SERVER_DOMAIN}` substitution), secret detection
- `cli/secrets.test.ts` — password generator entropy, length, charset
- `cli/server-create.test.ts` — golden-file fixtures for generated
  `servers/<n>/` trees; run TUI and non-interactive flows against the
  same fixtures
- `cli/wiring.test.ts` — adjacency-list patches applied to fixture
  dirs; assert Traefik labels / dynamic config correctness
- Per-stack smoke: `stack add <x> --non-interactive` produces a
  `servers/demo/` that passes `deno task check`

CI is not currently automated (per repo AGENTS.md). Tests stay in
`deno task test` and run on every commit via the existing pre-commit
hook.

---

## 11. Rollout phases

Each row is a separate PR. Each PR is small, focused, reviewable.
Sequential dependencies are noted; parallel work is parallelisable.

| # | PR | Depends on | What |
|---|---|---|---|
| 0 | #148 | — | Gitignore private server dirs. **In review now.** |
| 1 | repo rename | #148 merged | `homelab → rostok`. GitHub redirect. README header updated. |
| 2 | `cli/` skeleton | #1 | Add `cli/+main.ts` with @cliffy + zod. `rostok --help` works. No logic. |
| 3 | `StackMeta` + secrets | #2 | Type, default resolver, password generator, validation. Tests. |
| 4 | First 6 stacks | #3 | traefik, gatus, vaultwarden, jellyfin, filebrowser, librespeed get `+meta.ts`. Each its own commit / sub-PR if needed. |
| 5 | `server create` + `stack add` | #4 | TUI + non-interactive. The big one. |
| 6 | `stack list [--tree]` | #4 | Catalog browse + deps graph. Read-only, parallelisable with #5. |
| 7 | `deploy` wrapper | #5 | Thin alias for `deno task deploy`. |
| 8 | README + docs | #5, #6, #7 | Rewrite README, write docs/cli.md, docs/website.md. |
| 9 | Polish | #8 | `rostok --help` final pass, examples, full smoke test on demo server. |
| 10 | JSR publish | #9 | First release on JSR. Tagged. |
| — | v2 | #10 | Remote catalog, compiled binaries, static website, doctor, stack remove, server rename. |

Phases 2 and 3 are small and can ship fast (≤ 1 PR each).
Phase 5 is the largest — expect it to take 2-3 sub-PRs.
Phase 6 can be parallel with phase 5 (independent code path).

---

## 12. Open / deferred (captured in docs/cli.md)

- `rostok doctor` — sanity check (age installed, key present, hooks
  installed, syncthing reachable)
- `rostok stack remove` — symmetric to `stack add`
- `rostok server rename` / `server remove`
- Remote catalog (`--catalog <url>`) for plugins and private stacks
- Compiled binaries via `deno compile`
- Static website generated from sources
- Migration tool for existing `servers/{home,cloud,offsite}/` (user
  migrates manually; no importer needed)

---

## 13. Decisions log

Locked in conversation:

- **Name:** rostok (Russian "росток" = sprout)
- **Repo:** rename to `spy4x/rostok`
- **CLI library:** `@cliffy/command` + `@cliffy/prompt` (JSR v1.2.1, May 2026) + `npm:zod` (or `jsr:@zod/zod`) for validation
- **Multi-server:** v1 supports many servers per repo
- **v1 scope:** server create + stack add (core), stack list + deps graph, deploy wrapper
- **Catalog:** local `stacks/` in same repo for v1; remote catalog deferred to v2
- **First 6 stacks to migrate:** traefik, gatus, vaultwarden, jellyfin, filebrowser, librespeed
- **Cross-stack wiring:** adjacency-list on the stack (`connectsTo` in `+meta.ts`)
- **`.env` ownership:** defined in `+meta.ts` (`variables[].key` is the ownership list); no separate manifest file
- **Defaults policy:** strict — every `required: true` var needs default or flag
- **License:** MIT
- **Personas:** all three (hobbyist, multi-server homelabber, small company); big companies excluded
- **Distribution:** deno install from JSR primary; deno task rostok, npx/bunx, and compiled binaries all supported in v1+v2
- **No `rostok env ...` commands:** CLI manages .env while manipulating servers/stacks; env subcommand out of scope
- **Existing servers (home/cloud/offsite):** manual migration by user; no import tool in v1