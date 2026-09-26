# AGENTS.md — repo maintainer guide

Guidelines for AI agents and humans maintaining the **rostok** repo:
the catalog of self-hosted services and the CLI tool that scaffolds
users' projects.

What lives here is a **catalog** (`stacks/`) and the **CLI source**
(`scripts/hooks/`, plus the new `cli/` package in development). Env-file
encryption (age64) comes from the published `@spy4x/server/env-age64`
module, not from a local copy.

---

## 🟢 Repository layout

```
rostok/                          [tracked]
├── stacks/                      # the catalog — one dir per service
│   └── <stack>/
│       ├── compose.yml          # Docker Compose (must use `hl-` prefix)
│       ├── backup.ts            # backup config (skip for stateless)
│       ├── +meta.ts             # CLI schema (READY-TO-IMPLEMENT, see docs/design/v1-cli.md)
│       └── README.md            # what the stack does, how to configure
├── cli/                         # the rostok CLI source (added in v1 phase 2)
├── scripts/
│   ├── backup/                  # Restic backup system (per-stack backup.ts)
│   └── hooks/                   # git hooks (post-checkout, post-merge, pre-commit)
├── docs/                        # CLI docs, catalog, design notes
├── deno.jsonc                   # tasks + deps
├── README.md                    # public landing page
├── LICENSE
└── AGENTS.md                    # this file

rostok/                          [gitignored, personal — see below]
├── .env.root                    # plaintext deploy env vars
├── .env.root.age                # age64-encrypted .env.root
└── servers/
    └── <server>/                # one dir per real server (cloud, home, offsite, portable)
        ├── .env                 # plaintext per-server env
        ├── .env.age             # age64-encrypted per-server env
        ├── config.json          # server-level config
        └── configs/             # per-service configs (dash PWA, gatus, etc.)
```

`stacks/` is the catalog — every entry is reusable by any user. Never
hardcode a real domain, IP, or hostname in a stack. The catalog travels
through JSR; it's read by every `rostok` invocation.

---

## 🔒 Personal deploy state (kept locally, gitignored — never committed)

The repo's **tracked** tree is the public catalog only. The owner's
personal homelab deploy state lives here locally but is **never
committed** — all gitignored under `.gitignore`:

- `.env.root`, `.env.root.age` — root-level deploy env vars
  (caught by `.gitignore` patterns `.env` / `.env.*`)
- `servers/<server>/.env`, `.env.age` — per-server env vars
- `servers/<server>/config.json`, `configs/...` — per-server configs

**Why gitignored:** the repo travels through JSR; any tracked
personal data leaks the owner's infra to every consumer.

**Plan:** move this state to a separate location (e.g.
`~/apps/homelab/`) and out of the rostok repo entirely. Until then,
`deno task check` works as-is and the personal files don't
interfere with the catalog.

---

## 📝 Commit convention

```
<type>(<scope>): <short summary>
```

- Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `style`, `perf`, `ci`
- Scope: stack name, area, or `cli` for the CLI package
- Summary: lowercase, no period, imperative mood ("add", "drop", "fix")
- Subject ≤50 chars, hard cap 72
- Body only for non-obvious why

One logical change per commit. Run `deno task check` before every
commit. Fix issues first; don't commit anyway.

---

## ✅ Pre-commit checklist

```
deno task check
```

Runs `lint + fmt + type-check + tests`. All must pass before commit.

---

## 🔄 PR discipline

A PR MUST exist for any task. Create it immediately after the first
commit — even if the task is incomplete.

- Prefix title with `[WIP]` until fully done.
- Push + update PR body after every human interaction.
- Remove `[WIP]` only when complete and the review gate passed.
- Reference issues with full URLs in PR body:
  `Closes [#N](https://github.com/spy4x/rostok/issues/N)`.

---

## 📦 Stacks — what goes in `stacks/<name>/`

Every stack needs:

- `compose.yml` — Traefik labels, resource limits, `hl-` prefix
- `backup.ts` — skip for stateless services
- `README.md` — purpose, configuration, troubleshooting
- `+meta.ts` — CLI schema (see `docs/design/v1-cli.md` §4) — REQUIRED for v1

Rules:

- **Container name prefix `hl-`** — `hl-traefik`, `hl-gatus`, etc.
- **No hardcoded domains** — use `${DOMAIN}` or `${SERVER_DOMAIN}` in
  Traefik labels and env vars
- **No hardcoded secrets** — they go in `.env`, encrypted to `.env.age`
- **Defaults in `+meta.ts`** — every `required: true` variable has a
  `default` value or a `--var` flag fail mode

See `docs/contributing/adding-services.md` for the full author guide.

---

## 🧪 Code style

From `deno.jsonc` `fmt`:

- 2-space indent, 100 col, double quotes
- No semicolons, prose-wrap preserved
- Trust `deno fmt` — don't argue with it

From `deno.jsonc` `lint`:

- Recommended ruleset, `require-await` excluded
- Trust `deno lint` — fix warnings, don't suppress

### TypeScript

- Interfaces for object shapes, enums (start at 1) for constants,
  types for unions
- Named exports, async/await (no `.then()`)
- File naming: `kebab-case.ts`; main entry: `+main.ts`, library: `+lib.ts`

---

## 🔐 Secrets

`.env` is gitignored. `.env.age` is committed (encrypted with age64).
The age key lives in `.age/key.txt` (gitignored). Never commit the key.

Workflow:

1. Edit `.env`
2. `deno task env:encrypt` → writes `.env.age`
3. Commit `.env.age`

Per-value encryption: only changed lines re-encrypt. No churn on
unrelated keys.

`deno task env:encrypt`/`env:decrypt` (`jsr:@spy4x/server/env-age64/cli`)
now exit 1 when `.age/key.txt` is missing. The old tool printed that
the key was missing and exited 0. A missing key is now a real error,
not an optional prerequisite. That means `hooks:pre-commit` (`deno task check && deno
task env:encrypt`) fails on a project that hasn't run `rostok env
setup` yet. This is a deliberate choice, not an oversight: run `rostok
env setup` once per project before the first commit that touches
`.env`.

---

## 🔒 Security

- No real domains, IPs, hostnames, secrets, or PII in any committed file
- No webhook URLs, debug logs, `.env`-style material in source
- Public list of URLs the user shouldn't see (e.g. internal admin
  panels) — keep them out of catalog READMEs

---

## 🧹 Merge protocol

Agents work autonomously in this repo, including merging. A PR merges
when both gates are green:

- the pre-merge `@reviewer` gate (fresh-context review with its own
  checks and mutations; a separate security review for changes to
  deploy, SSH, secrets or auth), and
- CI on the PR (Woodpecker, `ci/woodpecker/pr/woodpecker`).

If a gate fails twice on the same cause, or a revert can't undo the
change, leave the PR open and tell the user.

- All commits relate to one feature → `gh pr merge --squash --delete-branch`
- Some commits fix independent things → `gh pr merge --rebase --delete-branch`

Publishing follows the same rule: once the version-bump PR is merged
and both gates are green, push the release tag without asking (see
"Publish flow" below). JSR versions are immutable, so tag only the
merged bump commit on `main`.

Then clean up. Worktrees live in the sibling `worktrees/rostok/`; these
commands work from any directory inside the repo or a worktree. `-D` is
needed because git doesn't see a squash-merged branch as merged; run it
only after the PR shows as merged.

```bash
MAIN=$(realpath "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")")
git -C "$MAIN" worktree remove "$(dirname "$MAIN")/worktrees/rostok/<type>/<short-description>"
git -C "$MAIN" branch -D <type>/<short-description>
git -C "$MAIN" fetch --prune
```

---

## 🚀 Quick reference

```
deno task check             # lint + fmt + type-check + tests
deno task fix               # auto-fix lint + fmt
deno task env:encrypt       # .env → .env.age
deno task env:decrypt       # .env.age → .env
deno task hooks:install     # install git hooks
deno task backup            # run Restic backup (per-stack backup.ts)
deno task backup:restore    # interactive restore
```

---

## 📦 Releasing — keep versions in sync

The package version is declared in **two places** that must stay
identical:

1. `deno.jsonc` — `version` field. Drives the JSR package version.
2. `cli/version.ts` — `VERSION` export. Drives `rostok --version`.

JSR versions are immutable once published, so a drift between the two
surfaces as `deno.jsonc: 1.0.2` installed while the binary prints
`rostok 1.0.1` (Phase 10 shipped this state). It also breaks
`import "jsr:@rostok/cli"` in downstream projects if anyone pins a
specific version.

### How to bump

Both files, every release. No exceptions.

```ts
// cli/version.ts
export const VERSION = "1.0.4"   // bump here

// deno.jsonc
"version": "1.0.4",              // and here — same value
```

Semver:

- **patch** (`1.0.X`) — bug fixes, refactors, no behavior change
- **minor** (`1.X.0`) — new CLI subcommand, new catalog stack, opt-in
  feature
- **major** (`X.0.0`) — breaking change to `+meta.ts` schema, exports,
  or the wizard output. Coordinate with downstream stack authors.

### Publish flow

After the version-bump PR merges to `main`. No need to ask first:

1. Tag the merge commit and push the tag:
   `git tag v1.0.4 <merge commit> && git push origin v1.0.4`.
2. Woodpecker runs `check` on the tag, then the `publish` step:
   `scripts/release/+main.ts` refuses a tag that differs from
   `deno.jsonc` or `cli/version.ts`, and `deno publish` uses the
   `JSR_TOKEN` repository secret (allowed for the tag event only). The
   CI checkout is clean, so no untracked local file can ship. A failed
   step publishes nothing: fix the cause in a PR, then move the tag to
   the new merge commit (`git tag -f`, `git push -f origin <tag>`).
3. Verify the new version with `deno install -A --global
   --minimum-dependency-age=0 -n rostok --force jsr:@rostok/cli`
   (the dep-age flag bypasses deno's 24h install delay on fresh
   publishes).
4. `rostok --version` must print the new version. If it prints an
   older one, you forgot to bump `cli/version.ts`.

### Avoid drift with `git grep`

If you ever need to verify the two values match without trusting this
doc:

```bash
grep -H '"version"' deno.jsonc cli/version.ts
# deno.jsonc:  "version": "1.0.4",
# cli/version.ts:export const VERSION = "1.0.4"
```

---

## 📚 See also

- `docs/design/v1-cli.md` — v1 design (ready-to-implement)
- `docs/design/v2-cli.md` — v2 backlog (draft)
- `docs/design/v2-website.md` — future static site (draft)
- `docs/usage/concepts.md` — stack, server, wizard
- `docs/usage/architecture.md` — how the pieces fit
- `docs/usage/catalog.md` — what's in the catalog
- `docs/usage/ENCRYPTED_ENV_FILES.md` — age64 workflow
- `docs/contributing/adding-services.md` — author a stack
- `docs/contributing/contributing.md` — PR checklist for contributors
