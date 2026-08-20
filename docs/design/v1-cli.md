# rostok v1 — design

**Status:** ready-to-implement.

Russian "росток" = sprout, seedling. A tiny shoot that grows into a full
homelab.

v1 ships a single onboarding command plus a small power-user API. v2
additions live in [`v2-cli.md`](v2-cli.md). Static-site plans live in
[`v2-website.md`](v2-website.md).

---

## 1. Vision

Three personas, served by one CLI:

| Persona | What they get |
|---|---|
| **Hobbyist** — old PC, wants a few services | One-command onboarding, sensible defaults, no jargon |
| **Multi-server homelabber** — 3 boxes, 20+ services | Cross-server wiring, dependency graph |
| **Small company** — replaces SaaS with self-hosted | SSO, backups, monitoring baked in; sensible security defaults |

Big companies out of scope. The README carries an explicit table so each
reader knows the tool is for them.

---

## 2. Repository strategy

- Repo at `github.com/spy4x/rostok` (renamed from `homelab`).
- `stacks/` catalog at repo root.
- CLI source at `cli/` in the same repo.
- Published to JSR as `@rostok/cli` — both the binary and the importable
  module come from the same package.
- Catalog is bundled into the CLI binary at publish time.
- Public users **do not fork**. They install the CLI globally and run it
  inside their own project folder.

```bash
# one-time per machine
deno install -A -n rostok jsr:@rostok/cli

# one-time per project
mkdir ~/rostok && cd ~/rostok
rostok                          # full wizard
```

License: MIT.

---

## 3. CLI surface

```
rostok                          # onboarding wizard (init + server create + stack add)
rostok server create [<name>]   # power-user: create one server
rostok stack add <name> --server=<name>  # power-user: add one stack
rostok stack list [--tree]      # browse bundled catalog
rostok deploy <server> [stack]  # wraps `deno task deploy`

rostok --help
rostok --version
```

### 3.1 `$ rostok` — onboarding wizard

No-args command. Three steps in sequence:

1. **Init** — idempotent project skeleton in cwd:
   ```
   .
   ├── deno.jsonc            # imports map for @rostok/cli, tasks
   ├── .gitignore            # secrets, runtime state
   ├── .git/                 # git init if missing and git is installed
   ├── servers/              # empty dir
   ├── .env.root             # CLI-managed root env (gitignored)
   └── .env.root.age         # encrypted (gitignored)
   ```
   - If any file already exists → warn, leave it alone.
   - If `.git/` present → skip `git init`.
   - If `git` is not installed on PATH → info-level message
     ("rostok recommends git for version control, but it's optional.
     Re-run rostok after installing it if you want a `.git/`."), skip
     `git init`. Non-tech users shouldn't be scared.

2. **Server create** — interactive prompts:
   - Server name
   - SSH target as a single alias string: `user@host:port` (port
     defaults to 22 if omitted). Stored verbatim.
   - Domain
   - Contact email
   - `~/.rostok/secrets/` for the age key, age64-encrypted (gitignored)

3. **Stack add** — interactive multi-select prompt: pick ONE stack from
   the bundled catalog. Runs that stack's variable flow.

After stack add, `.env.age` (and `.env.root.age` if root vars changed)
are re-encrypted automatically for git versioning.

### 3.2 Power-user subcommands

The subcommands exist for users who want finer control. They don't
duplicate the wizard — they do one step each:

- `rostok server create [<name>]` — same prompts as wizard step 2, but
  no init, no stack add.
- `rostok stack add <name> --server=<name>` — same as wizard step 3,
  but standalone.
- `rostok stack list [--tree]` — read-only catalog browse.
- `rostok deploy <server> [stack]` — thin wrapper over `deno task
  deploy`. Reads from the project's `deno.jsonc`.

### 3.3 Flags

```
-n, --non-interactive          # skip prompts, use defaults
    --server=<name>            # target server (for stack add, deploy)
    --var KEY=VAL              # repeatable; overrides one variable
    --stacks=<csv>             # bulk-add during non-interactive wizard
```

No `--yes`/`-y` alias. `--non-interactive`/`-n` only.

### 3.4 Strict-default policy

Every `required: true` variable in `+meta.ts` MUST have a `default` OR
a `--var KEY=VAL` flag. Missing both → command fails with the exact
flag syntax. Non-interactive mode never hangs.

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
      required: false,
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

`@rostok/cli` is mapped in the user's `deno.jsonc` to the JSR package:

```jsonc
{
  "imports": {
    "@rostok/cli": "jsr:@rostok/cli@^1"
  }
}
```

### Prompt rule

- `required: true` + no default + no `--var` → ask
- `required: true` + default present → use default, skip prompt
- `required: false` + default present → use default, skip prompt
- `required: false` + no default → omit, skip prompt

### Default resolution

Server-level vars resolved before stack vars. The single supported
reference is `${SERVER_NAME}`. v1 keeps this minimal.

### Secrets

- `secret: true` → never echoed, never logged
- `default: () => generatePassword(N)` — `crypto.getRandomValues`, base64
- Routed through age64 encryption automatically (see §6)

### Validation library

`npm:arktype@^2` (chosen after verifying the "faster + leaner than
zod" claim). Composes with cliffy via `Type<T>` wrapping. Use named
imports (`import { type } from "arktype"`).

---

## 5. Generated artifacts

`$ rostok` in an empty folder produces:

```
.
├── deno.jsonc
├── .gitignore
├── .git/                       # if git installed
├── .env.root                   # CLI-managed (gitignored)
├── .env.root.age               # encrypted (gitignored)
└── servers/
    └── home/
        ├── config.json         # which stacks (CLI-managed)
        ├── .env                # CLI-managed keys (gitignored)
        ├── .env.age            # encrypted (gitignored)
        ├── configs/            # per-service overrides
        └── README.md
```

**No `.env.example` files.** The schema lives in `+meta.ts`. CLI manages
`.env` directly. Re-encryption runs after every `.env` mutation (see
§6).

`config.json` shape is unchanged from current repo.

---

## 6. Re-encryption after .env manipulation

Every command that writes to `servers/<n>/.env` or `.env.root` MUST
re-encrypt the corresponding `.env.age` immediately afterwards. This
keeps `.env.age` always current with `.env`, so committing
`.env.age` to git is meaningful (no stale state).

Concrete triggers:
- Wizard step 2 (server create) writes `.env` → encrypt.
- Wizard step 3 (stack add) writes `.env` → encrypt.
- Power-user `server create` writes `.env` → encrypt.
- Power-user `stack add` writes `.env` → encrypt.
- Any `.env.root` change → encrypt `.env.root.age`.

Implementation: call the existing `deno task env:encrypt` flow after
each write. Failures are non-fatal (warn) — the wizard should not block
on encrypt hiccups.

---

## 7. `.env` ownership

The list of `variables[].key` in `+meta.ts` IS the ownership list. No
extra manifest file.

When CLI writes `servers/<n>/.env`:
- Keys declared by stack X → written/updated by stack X's setup
- Keys not declared by any stack → preserved untouched
- Hand-edits to declared keys → preserved on `--var` only if explicit

Tradeoff: hand-edit to a CLI-managed key gets clobbered on next `stack
add`. Acceptable because CLI-managed keys are always overridable via
`--var`, and a clear log line tells the user which keys the CLI is
about to write.

---

## 8. Distribution

1. `deno install -A -n rostok jsr:@rostok/cli` — primary. Gives both
   binary and importable module.
2. `deno task rostok` from a cloned `spy4x/rostok` — developer path.
3. `npx rostok` / `bunx rostok` via npm tarball — v2.

---

## 9. Documentation

- `README.md` — personas table, quickstart (`$ rostok`), command
  reference, link to `docs/design/v1-cli.md`.
- `docs/design/v1-cli.md` — this file.
- `docs/design/v2-cli.md` — v2 backlog.
- `docs/design/v2-website.md` — future static site idea.

Repository's other docs (`docs/usage/architecture.md`, `docs/usage/...`)
stay as-is — they're independent of the CLI work.

---

## 10. Testing

- `cli/stack-meta.test.ts` — schema, default resolution, prompt rule
- `cli/secrets.test.ts` — password generator (entropy, length, charset)
- `cli/wizard.test.ts` — full wizard on tmp dir; asserts deno.jsonc,
  .gitignore, .env.age, servers/<n>/ structure
- `cli/server-create.test.ts` — golden-file fixtures
- `cli/stack-add.test.ts` — variable merging, ownership preservation
- `cli/encrypt-after-write.test.ts` — every mutation path leaves
  `.env.age` current with `.env`
- Per-stack smoke: `rostok --non-interactive --server=home
  --stacks=traefik` produces a deployable dir that passes
  `deno task check`

CI not automated (per repo AGENTS.md). Tests stay in `deno task test`,
run via pre-commit hook.

---

## 11. Rollout phases

Each row is a separate PR. ✅ = done.

| # | PR | Depends on | What |
|---|---|---|---|
| 0 | [#148](https://github.com/spy4x/rostok/pull/148) ✅¹ | — | Gitignore private server dirs. |
| 1 | [#153](https://github.com/spy4x/rostok/pull/153) ✅ | #0 merged | `homelab → rostok`. GitHub redirect. README header. |
| 1.5 | [#154](https://github.com/spy4x/rostok/pull/154) ✅ | #1 merged | Strip user-specific dirs/docs. Catalog becomes public. |
| 1.6 | recover + doc split | #1.5 merged | Restore scripts/, ansible/, deno.jsonc tasks. Split docs into usage/contributing/design. DR doc. Catalog .md links. |
| 2 | `cli/` skeleton | #1.5 | `cli/+main.ts` with cliffy + arktype. `rostok --help` works. |
| 3 | `StackMeta` + secrets | #2 | Type, default resolver, password generator, validation. |
| 4 | First 6 stacks | #3 | traefik, gatus, vaultwarden, jellyfin, filebrowser, librespeed get `+meta.ts`. One commit per stack. |
| 5 | wizard + power-user API | #4 | `$ rostok`, `server create`, `stack add`. Re-encryption after every write. |
| 6 | `stack list [--tree]` | #4 | Catalog browse + deps graph. Parallel with #5. |
| 7 | `deploy` wrapper | #5 | Thin alias for `deno task deploy`. |
| 8 | README + docs | #5, #6, #7 | Rewrite README, ship v1/v2/v2-website docs. |
| 9 | Polish | #8 | Help text, examples, smoke. |
| 10 | JSR publish | #9 | First release. |
| — | v2 | #10 | See `v2-cli.md`. |

¹ Phase 0 landed via direct squash-push to `main` (commit `f22135a`)
because the repo's no-merge-commits rule was strict at the time. The
PR was closed without merge; the work is on `main`.

---

## 12. Decisions log

Locked in conversation:

- **Name:** rostok (Russian "росток" = sprout)
- **Repo:** rename to `spy4x/rostok`
- **CLI library:** `@cliffy/command` + `@cliffy/prompt` (JSR v1.2.1)
- **Validation library:** `npm:arktype@^2`
- **Distribution model:** users install CLI globally; do not fork
- **Multi-server:** v1 supports many servers per project
- **v1 surface:** wizard (`$ rostok`) + `server create` + `stack add` +
  `stack list [--tree]` + `deploy` wrapper
- **First 6 stacks:** traefik, gatus, vaultwarden, jellyfin,
  filebrowser, librespeed
- **Cross-stack wiring:** deferred to v2
- **`.env.example` files:** removed in v1. Schema lives in `+meta.ts`.
  CLI manages `.env` directly.
- **`.env.age` re-encryption:** runs automatically after every `.env`
  mutation
- **`.env.root`:** generated during `$ rostok`; CLI-managed
- **`.env` ownership:** defined in `+meta.ts` (`variables[].key`); no
  separate manifest
- **Defaults policy:** strict — every `required: true` var needs
  default or `--var` flag
- **Server-level vars:** only `${SERVER_NAME}` for substitution
- **`IMAGE_TAG` placement:** inside `variables[]`, not separate
  defaults block
- **Flags:** only `--non-interactive` / `-n`; no `--yes` / `-y`
- **License:** MIT
- **Personas:** hobbyist + multi-server homelabber + small company
- **PR #148:** land before phase 1