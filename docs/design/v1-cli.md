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
rostok env encrypt              # run `deno task env:encrypt` directly
rostok env decrypt              # run `deno task env:decrypt` directly
rostok env status               # show encryption posture + next steps

rostok --help
rostok --version
```

### 3.1 `$ rostok` — onboarding wizard

No-args command. Three steps in sequence. Phase 4 user feedback split
`.env.root` (cross-server) from `servers/<server>/.env` (per-server) —
see §5 for the layout and §7 for ownership.

1. **Init** — idempotent project skeleton in cwd:
   ```
   .
   ├── deno.jsonc            # imports map for @rostok/cli
   ├── .gitignore            # plaintext secrets only (.env, .env.root)
   ├── .git/                 # git init if missing and git is installed
   ├── servers/              # empty dir
   └── .env.root             # CLI-managed cross-server vars (gitignored)
   ```
   - If any file already exists → warn, leave it alone.
   - If `.git/` present → skip `git init`.
   - If `git` is not installed on PATH → info-level message
     ("rostok recommends git for version control, but it's optional.
     Re-run rostok after installing it if you want a `.git/`."), skip
     `git init`. Non-tech users shouldn't be scared.
   - `.env.age` and `.env.root.age` are **NOT** gitignored. They're
     age64-encrypted blobs — safe to commit; that's the whole point.
   - **Encryption is optional but endorsed.** If `age` is not on PATH,
     the wizard prints a one-time info-level tip ("install age, then
     re-run rostok — it will offer to set up encryption") and runs to
     completion without encrypting. If `age` IS on PATH but no key is
     present, the wizard prompts the user to generate one (rostok runs
     `age-keygen` itself — the user never has to know that command
     exists). The CLI never blocks on this — encryption is a nice-to-
     have for keeping `.env.age` in git; it's not required for the
     wizard.

2. **Server create** — interactive prompts; writes to
   `servers/<server>/.env` (NOT `.env.root`):
   - Server name → directory name under `servers/`
   - SSH target — single string. Either an `ssh_config` alias
     (`homelab`) or a connection string (`user@host[:port]`). No
     validation. If `user@host` form, the user is extracted and used
     as the hint for the next prompt.
   - User — defaults to the user extracted from SSH target, or
     current shell user. Skip the prompt entirely if SSH target was
     `user@host` form (the user is already known).
   - Domain — apex domain for this server
   - Contact email — for ACME/Let's Encrypt registration
   - `PROJECT` — short project identifier (e.g. `hl`)
   - `DOCKER_GROUP_ID` — group ID for `/var/run/docker.sock` access
   - `TIMEZONE` — IANA tz, defaults to `/etc/timezone` or `UTC`
   - `PUID`, `PGID` — container user/group IDs
   - `VOLUMES_PATH` — host dir for compose volumes
   - `BASIC_AUTH_*` (only added in Phase 5+ when stacks need it)

3. **Stack add** — interactive multi-select prompt: pick ONE stack from
   the bundled catalog. Runs that stack's variable flow. Builds the
   `ServerContext` from `servers/<server>/.env` (per-server vars) so
   `${DOMAIN}`, `${TIMEZONE}`, `${PUID}`, `${PGID}`, `${VOLUMES_PATH}`,
   `${PATH_*}` all resolve.

After stack add, `servers/<server>/.env.age` is re-encrypted (if age
is available; otherwise the user runs `rostok env encrypt` later).

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
├── .gitignore            # plaintext secrets only (.env, .env.root)
├── .git/                 # if git installed
├── .env.root            # CLI-managed cross-server vars (gitignored)
├── .env.root.age        # encrypted — safe to commit
└── servers/
    └── home/
        ├── config.json  # which stacks (CLI-managed, committed)
        ├── .env         # CLI-managed per-server vars (gitignored)
        ├── .env.age     # encrypted — safe to commit
        ├── configs/     # per-service overrides (committed)
        └── README.md
```

**`.env.age` and `.env.root.age` are safe to commit.** They're age64-
encrypted blobs. The plaintext `.env` and `.env.root` are the secrets;
they stay gitignored. Encrypt-on-write is **optional but endorsed** —
the CLI runs `age-keygen` transparently when the user accepts the
post-init prompt (or invokes `rostok env setup` later). The user never
has to call `age-keygen` themselves.

**No `.env.example` files.** The schema lives in `+meta.ts`. CLI manages
`.env` directly. Re-encryption runs after every `.env` mutation (see
§6) when `age` is available.

`config.json` shape is unchanged from current repo.

### 5.1 What goes where

Phase 4 user feedback split server config into two files:

**`.env.root` — cross-server, shared by every `servers/<n>/`:**
- `BACKUPS_PASSWORD` — restic repo password
- `BACKUP_PATHS` — paths included in backups (e.g. `/etc`, `/var/lib`)
- `CLOUDFLARE_API_TOKEN` — for DNS-01 ACME challenges

**`servers/<server>/.env` — per-server, deploy identity + container
config:**
- `PROJECT` — short project ID (e.g. `hl`)
- `SSH_ADDRESS` — verbatim ssh target (alias or `user@host[:port]`)
- `USER` — shell user on the remote host (parsed from SSH or prompted)
- `DOMAIN` — apex domain for this server
- `CONTACT_EMAIL` — for ACME/Let's Encrypt registration
- `DOCKER_GROUP_ID` — group ID for `/var/run/docker.sock` access
- `TIMEZONE` — IANA tz, defaults to `/etc/timezone` or `UTC`
- `PUID`, `PGID` — container user/group IDs
- `VOLUMES_PATH` — host dir for compose volumes
- `BASIC_AUTH_*` — basic-auth credentials (when stack needs it)
- `PATH_*` — host dirs for media libraries (PATH_MEDIA, etc.)

The wizard's `$ rostok` action creates `.env.root` empty by default;
the user populates it manually for cross-server creds. The wizard's
"server create" step writes to `servers/<server>/.env`.

---

## 6. Re-encryption after .env manipulation

Every command that writes to `servers/<n>/.env` or `.env.root` SHOULD
re-encrypt the corresponding `.env.age` immediately afterwards. This
keeps `.env.age` always current with `.env`, so committing
`.env.age` to git is meaningful (no stale state).

**Encryption is optional but endorsed.** The CLI actively recommends it
but never requires it. Concrete behavior:

- `age` on PATH + `.age/key.txt` present → encrypt runs after every
  `.env` write (`cli/encrypt.ts:encryptEnvFiles`). Best effort — any
  task failure is warned, not thrown; the wizard completes anyway.
- `age` on PATH, no `.age/key.txt` → skip with a one-time hint about
  `age-keygen`. The wizard still completes.
- `age` missing entirely → skip with a one-time hint about
  `apt install age`. The wizard still completes.

After `init`, the CLI prints an info-level tip about age if it's not
set up (single-shot — idempotent calls stay quiet).

Concrete triggers:
- Wizard step 2 (server create) writes `servers/<n>/.env` → encrypt.
- Wizard step 3 (stack add) writes `servers/<n>/.env` → encrypt.
- Power-user `server create` writes `servers/<n>/.env` → encrypt.
- Power-user `stack add` writes `servers/<n>/.env` → encrypt.
- Any `.env.root` change → encrypt `.env.root.age`.

Implementation: call the existing `deno task env:encrypt` flow after
each write. Failures are non-fatal (warn) — the wizard should not block
on encrypt hiccups. The wrapper (`cli/encrypt.ts`) detects `age`
presence up front so the task is only spawned when it can succeed.

User-side key management: the wizard does NOT auto-generate age
keypairs. Encryption is opt-in. If the user wants to encrypt their
`.env.age`, they run `age-keygen -o .age/key.txt` once, then commit
`.env.age` (NOT `.age/key.txt`).

### 6.1 Explicit `rostok env ...` commands

The wizard auto-runs encrypt after every `.env` write. For ad-hoc
needs (backfilling after installing `age`, decrypting a fresh clone),
the user can invoke the same logic directly:

- `rostok env encrypt` — runs `deno task env:encrypt`. Exits non-zero
  if `age` is missing or `.age/key.txt` is missing (explicit error —
  the user invoked the command deliberately).
- `rostok env decrypt` — runs `deno task env:decrypt`. Same exit
  semantics.
- `rostok env status` — prints whether `age` is on PATH, whether
  `.age/key.txt` exists, and the list of `.env` / `.env.age` files.
  Exits 0 always. Ends with a recommendation that never exposes raw
  `age-keygen` commands — instead points at `rostok env setup` and
  re-running `rostok`.
- `rostok env setup` — generates `.age/key.txt` for the user. The CLI
  runs `age-keygen` internally; the user never has to know that
  command exists.

These are thin wrappers — they do exactly what the encrypt/decrypt
tasks do. The only added value is the friendly status output, the
exit-code-by-missing-dependency for `encrypt`/`decrypt`, and the
encapsulation of `age-keygen` behind `rostok env setup`.

---

## 7. `.env` ownership

The list of `variables[].key` in `+meta.ts` IS the ownership list. No
extra manifest file.

### 7.1 Per-stack ownership (`servers/<n>/.env`)

When CLI writes `servers/<n>/.env`:
- Keys declared by stack X → written/updated by stack X's setup
- Keys declared by `server create` (PROJECT, SSH_ADDRESS, USER, DOMAIN,
  CONTACT_EMAIL, DOCKER_GROUP_ID, TIMEZONE, PUID, PGID, VOLUMES_PATH,
  PATH_*) → written/updated by server-create; not clobbered by stack-add
  (stack-add's merge preserves them)
- Keys not declared by any stack → preserved untouched
- Hand-edits to declared keys → preserved on `--var` only if explicit

Tradeoff: hand-edit to a CLI-managed key gets clobbered on next `stack
add`. Acceptable because CLI-managed keys are always overridable via
`--var`, and a clear log line tells the user which keys the CLI is
about to write.

### 7.2 Per-project root (`.env.root`)

`server create` does NOT touch `.env.root`. The wizard creates it empty
during init; the user populates it manually for cross-server creds
(BACKUPS_PASSWORD, BACKUP_PATHS, CLOUDFLARE_API_TOKEN). The CLI never
prompts for these — they're outside the per-server flow.

If the user wants the CLI to help populate `.env.root`, they edit it
manually or run `deno task env:encrypt` after manual edits. There's no
`rostok root edit` subcommand in v1.

### 7.3 No `~/.rostok/secrets/`

Earlier designs referenced `~/.rostok/secrets/` for a global age
keypair. Phase 5 user feedback dropped this: the keypair lives in
`<project>/.age/key.txt` (committed only to the user's local machine
or secret manager — never to the public repo). One key per project is
simpler than a global key across projects.

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
| 1.6 | [#156](https://github.com/spy4x/rostok/pull/156) ✅ | #1.5 merged | Recover scripts/, ansible/, split docs/usage|contributing|design. |
| 2 | [#157](https://github.com/spy4x/rostok/pull/157) ✅ | #1.5 | `cli/` skeleton with cliffy + arktype. `rostok --help` works. |
| 3 | [#158](https://github.com/spy4x/rostok/pull/158) ✅ | #2 | `StackMeta` type, default resolver, password generator, arktype-cliffy bridge. |
| 4 | [#159](https://github.com/spy4x/rostok/pull/159) ✅ | #3 | First 6 stacks ship `+meta.ts`. One commit per stack. Phase 4 user feedback: single `<SERVICE>_DOMAIN` pattern, vaultwarden SMTP optional, server-level vars (`${DOMAIN}`, `${TIMEZONE}`, `${PUID}`, `${PGID}`, `${VOLUMES_PATH}`, `${PATH_*}`) added to `${...}` allow-list. |
| 5 | [#160](https://github.com/spy4x/rostok/pull/160) (WIP) | #4 | Wizard (`$ rostok`) + `server create` + `stack add`. Re-encryption hook. `rostok env encrypt|decrypt|status` for explicit encryption control. Encryption marked optional-but-endorsed: wizard completes even when `age` is missing; init prints a one-time tip about installing `age` + generating a keypair. `.env.root` / `servers/<n>/.env` split. SSH target accepts `user@host[:port]` OR alias. |
| 5b | — | #5 | `--stacks=<csv>` bulk-add for non-interactive wizard. |
| 6 | — | #5 | `stack list [--tree]` — catalog browse + deps graph. Parallel with #5. |
| 7 | — | #5 | `deploy` wrapper — thin alias for `deno task deploy`. |
| 8 | — | #5, #6, #7 | Rewrite README, ship v1/v2/v2-website docs. |
| 9 | — | #8 | Help text, examples, smoke. |
| 10 | — | #9 | JSR publish. First release. |
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