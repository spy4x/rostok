# rostok v1 — design

**Status:** draft, awaiting review.
**Goal:** design document for the `rostok` v1 CLI tool.

Russian "росток" = sprout, seedling. A tiny shoot that grows into a full
homelab. The CLI plants it from the catalog.

This document covers v1 only. v2 ideas (cross-stack wiring, remote
catalog, telemetry, aliases, etc.) live in [`v2-cli.md`](v2-cli.md).
Static-site plans live in [`v2-website.md`](v2-website.md).

---

## 1. Vision

`rostok` turns the `stacks/` catalog into a working per-user homelab
through a small, opinionated CLI. The same tool works for three
personas:

| Persona | What they get |
|---|---|
| **Hobbyist** — old PC, wants a few services | Sensible defaults, single command onboarding, no jargon |
| **Multi-server homelabber** — 3 boxes, 20+ services | Cross-server wiring, dependency graph |
| **Small company** — replaces SaaS with self-hosted | SSO, backups, monitoring baked in; sensible security defaults |

Big companies are intentionally out of scope. The repo stays small and
homelab-shaped; production k8s/enterprise tooling serves them better.

The README carries an explicit table covering all three groups so each
reader knows the tool is for them.

---

## 2. Repository strategy

- Repo at `github.com/spy4x/rostok` (renamed from `homelab` in rollout
  phase 1).
- The `stacks/` catalog lives at the repo root.
- CLI source lives at `cli/` in the same repo.
- Published to JSR as `@rostok/cli`. The CLI binary AND the importable
  module come from the same package.
- Public users **do not fork** the repo. They install the CLI globally
  and run it inside their own project folder.

```bash
# one-time per machine
deno install -A -n rostok jsr:@rostok/cli

# one-time per project
mkdir ~/homelab && cd ~/homelab
rostok init
rostok server create home
rostok stack add traefik --server=home
```

The catalog is bundled into the CLI binary at publish time. Customising
the catalog (writing your own `+meta.ts`) is supported — that's a v2
ergonomics question, see `v2-cli.md`.

- License: MIT.

---

## 3. CLI commands — v1 surface

```
rostok                                    # top-level help
rostok --version
rostok --help

rostok init                                # create project skeleton in cwd
rostok server create [<name>]              # scaffold servers/<name>/
rostok stack add <name> --server=<name>    # add one stack to an existing server
rostok stack list [--tree]                 # browse bundled catalog
rostok deploy <server> [stack]             # wraps `deno task deploy`
```

### `rostok init`

Creates the project skeleton in the current directory:

```
.
├── deno.jsonc              # imports map for @rostok/cli, tasks
├── .gitignore              # secrets, generated files, runtime state
├── .git/                   # git init — optional, warns if exists
└── servers/                # empty dir, populated by `server create`
```

Idempotent. If a file already exists, warn and leave it alone. Never
overwrites. Skips `git init` if `.git` is already present.

### `rostok server create [<name>]`

Creates `servers/<name>/` with `config.json`, `.env`, `.env.example`,
`configs/`, `README.md`. **Does not add any stacks.** Stacks come in
one-by-one via `stack add`.

Interactive prompts (in order):
1. Server name (if not given)
2. SSH target (address, port, user)
3. Domain
4. Contact email

### `rostok stack add <name> --server=<name>`

Adds one stack to an existing server. Runs that stack's variable
prompts, updates `servers/<n>/config.json` and `servers/<n>/.env`.

### `rostok stack list [--tree]`

Lists all stacks in the bundled catalog. `--tree` shows the (small,
intra-catalog) dependency graph. Read-only.

### `rostok deploy <server> [stack]`

Thin wrapper over `deno task deploy <server> [stack]`. Lives in the
project (uses `deno.jsonc` tasks), not the global CLI.

### Non-interactive flags

- `--non-interactive` / `--yes` / `-y` — skip prompts, use defaults
- `--server=<name>` — target server
- `--var KEY=VAL` — repeatable, overrides a single variable

### Strict-default policy

Every `required: true` variable in `+meta.ts` MUST have either a
`default` value or a `--var KEY=VAL` flag on the command line. Missing
both → command fails with the exact flag syntax. Guarantees
non-interactive mode never hangs and is automation-friendly.

---

## 4. Stack schema — `stacks/<name>/+meta.ts`

```typescript
import type { StackMeta } from "@rostok/cli"
import { generatePassword } from "@rostok/cli"

export default {
  name: "traefik",
  description: "Reverse proxy with auto-TLS via Let's Encrypt",
  category: "proxy",
  variables: [
    {
      key: "IMAGE_TAG",
      default: "3.5",
      required: false,   // never prompted when default present
    },
    {
      key: "DOMAIN",
      question: "Primary domain for this server?",
      default: "${SERVER_NAME}",
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
} satisfies StackMeta
```

`@rostok/cli` is mapped in the user's `deno.jsonc` (written by
`rostok init`) to the JSR package:

```jsonc
// deno.jsonc
{
  "imports": {
    "@rostok/cli": "jsr:@rostok/cli@^1"
  }
}
```

### Default resolution

Server-level vars resolved first. The single supported reference is
`${SERVER_NAME}` (server's `name` field). v1 keeps this minimal; richer
expansion lives in `v2-cli.md`.

### Prompt rule

- `required: true` + no default + no `--var` → ask
- `required: true` + default present → use default, skip prompt
- `required: false` + default present → use default, skip prompt
- `required: false` + no default → omit, skip prompt

### Secrets

- `secret: true` → never echoed, never logged
- `default: () => generatePassword(N)` — `crypto.getRandomValues`, base64
- Routed through age64 encryption automatically when `env:encrypt` runs

### Variable typing + validation (arktype)

Runtime validation uses `npm:arktype@^2` (chosen after verifying the
"faster, leaner than zod" claim — see `docs/decisions/arktype-vs-zod.md`
for the benchmark). Arktype composes with cliffy via `Type<T>` wrapping:

```typescript
import { Type } from "jsr:@cliffy/command@1.2.1"
import { type } from "npm:arktype@2"

class Port extends Type<number> {
  parse({ label, value }: ParseContext): number {
    const out = type("0 <= number <= 65535")(Number(value))
    if (out instanceof type.errors) throw new Error(out.summary)
    return out
  }
}
```

The same pattern wraps every stack's `+meta.ts` variables. Each
variable carries an optional `schema` (arktype type string) that the
CLI evaluates before accepting the value.

---

## 5. Generated artifacts

`rostok server create home` produces:

```
servers/home/
├── config.json                 # which stacks (CLI-managed)
├── .env                        # merged stack vars (CLI-managed keys)
├── .env.age                    # age64-encrypted (gitignored)
├── .env.example                # public template (gitignored outside demo/)
├── configs/                    # per-service overrides
└── README.md                   # server-specific notes
```

`config.json` shape is unchanged from current repo.

`rostok stack add traefik --server=home` appends to `config.json` and
writes its declared variables into `.env`.

---

## 6. `.env` ownership

The list of `variables[].key` in `+meta.ts` IS the ownership list. No
extra manifest file.

When CLI writes `servers/<n>/.env`:
- Keys declared by stack X → written/updated by stack X's setup
- Keys not declared by any stack → preserved untouched
- Hand-edits to declared keys → preserved on `--var` only if explicit

Rationale: keeps the schema self-describing; no parallel metadata to
keep in sync. Tradeoff: a hand-edit to a CLI-managed key gets clobbered
on next `stack add`. This is acceptable because CLI-managed keys are
always overridable via `--var`, and a clear log line tells the user
which keys the CLI is about to write.

---

## 7. Distribution

Multiple paths, all supported in v1:

1. `deno install -A -n rostok jsr:@rostok/cli` — primary, gives both
   binary and importable module
2. `deno task rostok` from a cloned `spy4x/rostok` (developer path)
3. `npx rostok` / `bunx rostok` via npm tarball — v2

JSR is the primary distribution because Deno-native, semver-clean, no
publish-time surprises.

---

## 8. Documentation (v1 scope)

- `README.md` — rewritten. Personas table, quickstart, command
  reference, link to `docs/v1-cli.md`
- `docs/v1-cli.md` — this file
- `docs/v2-cli.md` — v2+ backlog
- `docs/v2-website.md` — future static site
- `docs/decisions/` — design decision records (e.g.
  `arktype-vs-zod.md`, `cliffy-vs-alternatives.md`)

Static website is deferred to v2 — see `v2-website.md`.

---

## 9. Testing

- `cli/stack-meta.test.ts` — schema validation, default resolution
  (`${SERVER_NAME}` substitution), prompt rule
- `cli/secrets.test.ts` — password generator entropy, length, charset
- `cli/server-create.test.ts` — golden-file fixtures for generated
  `servers/<n>/` trees
- `cli/stack-add.test.ts` — variable merging, ownership preservation
- Per-stack smoke: `stack add <x> --non-interactive` produces a
  `servers/<n>/` that passes `deno task check`

CI is not currently automated (per repo AGENTS.md). Tests stay in
`deno task test` and run on every commit via the existing pre-commit
hook.

---

## 10. Rollout phases

Each row is a separate PR. Sequential dependencies are noted; parallel
work is parallelisable.

| # | PR | Depends on | What |
|---|---|---|---|
| 0 | [#148](https://github.com/spy4x/homelab/pull/148) | — | Gitignore private server dirs. **In review now.** |
| 1 | repo rename | #0 merged | `homelab → rostok`. GitHub redirect. README header updated. |
| 2 | `cli/` skeleton | #1 | `cli/+main.ts` with cliffy + arktype. `rostok --help` works. No logic. |
| 3 | `StackMeta` + secrets | #2 | Type, default resolver, password generator, validation. Tests. |
| 4 | First 6 stacks | #3 | traefik, gatus, vaultwarden, jellyfin, filebrowser, librespeed get `+meta.ts`. One commit per stack. |
| 5 | `init` + `server create` + `stack add` | #4 | TUI + non-interactive. The big one. |
| 6 | `stack list [--tree]` | #4 | Catalog browse + deps graph. Read-only, parallelisable with #5. |
| 7 | `deploy` wrapper | #5 | Thin alias for `deno task deploy`. |
| 8 | README + docs | #5, #6, #7 | Rewrite README, ship v1-cli/v2-cli/v2-website. |
| 9 | Polish | #8 | Help text final pass, examples, full smoke test. |
| 10 | JSR publish | #9 | First release on JSR. Tagged. |
| — | v2 | #10 | See `v2-cli.md` for backlog. |

Phase 5 is the largest — expect 2-3 sub-PRs.
Phase 6 can run in parallel with phase 5.

---

## 11. Decisions log

Locked in conversation:

- **Name:** rostok (Russian "росток" = sprout)
- **Repo:** rename to `spy4x/rostok`
- **CLI library:** `@cliffy/command` + `@cliffy/prompt` (JSR v1.2.1)
- **Validation library:** `npm:arktype@^2` (verified faster + leaner than
  zod; composes with cliffy via `Type<T>`)
- **Users:** do not fork. Install CLI globally, run it in their own
  project folder. (Future: write their own `+meta.ts` stacks.)
- **Multi-server:** v1 supports many servers per repo
- **v1 scope:** `init`, `server create`, `stack add`, `stack list`,
  `deploy` wrapper
- **Catalog:** bundled into the CLI binary at publish time
- **First 6 stacks to migrate:** traefik, gatus, vaultwarden, jellyfin,
  filebrowser, librespeed
- **Cross-stack wiring:** deferred to v2 (see `v2-cli.md`)
- **`--stacks=<csv>` bulk flag:** not in v1; `server create` stays
  minimal, stacks added one-by-one via `stack add`
- **`.env` ownership:** defined in `+meta.ts` (`variables[].key` is the
  list); no separate manifest file
- **Defaults policy:** strict — every `required: true` var needs default
  or flag
- **Server-level vars:** only `${SERVER_NAME}` is supported for
  substitution in v1
- **`IMAGE_TAG` placement:** inside `variables`, not in a separate
  `defaults` block
- **License:** MIT
- **Personas:** all three (hobbyist, multi-server homelabber, small
  company); big companies excluded
- **Distribution:** JSR primary; `deno task rostok` and `npx`/`bunx`
  supported in v2
- **No `rostok env ...` commands:** CLI manages `.env` while
  manipulating servers/stacks
- **Existing servers (home/cloud/offsite):** manual migration by user;
  no import tool in v1
- **PR #148:** recommended to land before phase 1 (independent value,
  pre-req for repo being public-safe)