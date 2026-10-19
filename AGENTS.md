# AGENTS.md — rostok

Read `README.md` first. The global agent instructions own Git Flow, review and cleanup; this file
adds what is specific to this repo.

Guidelines for AI agents and humans maintaining the **rostok** repo: the catalog of self-hosted
services and the CLI tool that scaffolds users' projects.

What lives here is a **catalog** (`stacks/`) and the **CLI source**
(`cli/`). Env-file encryption (age64) comes from the published
`@spy4x/server/env-age64` module, not from a local copy.

---

## 🟢 Repository layout

```
rostok/                          [tracked]
├── stacks/                      # the catalog — one dir per service
│   └── <stack>/
│       ├── compose.yml          # Docker Compose (must use `hl-` prefix)
│       ├── backup.ts            # backup config (skip for stateless)
│       ├── +meta.ts             # CLI schema (see docs/design/v1-cli.md)
│       └── README.md            # what the stack does, how to configure
├── cli/                         # the rostok CLI source
│   └── offline/                 # `rostok offline`: copy of the backups on an external drive
├── scripts/
│   ├── backup/                  # Restic backup runner (servers run it from a pinned clone)
│   ├── stalwart/                # helpers for the stalwart mail stack
│   ├── release/                 # tag-versus-version guard for publishing
│   └── hooks/                   # git pre-commit hook (runs `deno task check`)
├── docs/                        # CLI docs, catalog, design notes
├── deno.jsonc                   # tasks + deps
├── README.md                    # public landing page
├── LICENSE
└── AGENTS.md                    # this file
```

`stacks/` is the catalog — every entry is reusable by any user. Never
hardcode a real domain, IP, or hostname in a stack. The catalog travels
through JSR; it's read by every `rostok` invocation.

---

## 🔒 No servers, settings or secrets here

This repo holds only the public catalog and the CLI. A user's servers,
settings and secrets live in their own rostok project (the folder
`rostok init` creates), never in this checkout. `.gitignore` still lists
`servers/` and `.env*` as a guard, and no task or script here reads them.

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

## 💸 Tests on a fresh VPS

A test that needs a fresh server runs on a Hetzner Cloud server you
create for it and delete as soon as the test ends, whether it passed or
failed. Watch the budget: pick the cheapest server type that runs the
test, keep it no longer than the test needs, and leave no server, SSH
key or volume behind. `deno task e2e:vps` does all of this for you
(see "Real-server test" in `docs/contributing/contributing.md`);
prefer it to creating a server by hand.

---

## 🔄 PR discipline

- Push + update PR body after every human interaction.
- Reference issues with full URLs in PR body:
  `Closes [#N](https://github.com/spy4x/rostok/issues/N)`.

---

## 📦 Stacks — what goes in `stacks/<name>/`

Every stack needs:

- `compose.yml` — Traefik labels, resource limits, `hl-` prefix
- `backup.ts` — skip for stateless services
- `README.md` — purpose, configuration, troubleshooting
- `+meta.ts` — CLI schema (see `docs/design/v1-cli.md` §4) — REQUIRED

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

- 2-space indent, 100 col, double quotes (this overrides the global
  "backticks for strings" rule; backticks only for interpolation)
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

This repo tracks no env file, so it has no `env:encrypt` task and no
age key. What follows describes a user's rostok project, which the CLI
manages.

`.env` is gitignored. `.env.age` is committed (encrypted with age64).
The age key lives in `.age/key.txt` (gitignored). Never commit the key.

Workflow, in the project:

1. Edit `.env`
2. `rostok env encrypt` → writes `.env.age`
3. Commit `.env.age`

Per-value encryption: only changed lines re-encrypt. No churn on
unrelated keys. `rostok env encrypt` needs `.age/key.txt`: run
`rostok env setup` once per project before the first commit that
touches `.env`.

---

## 🔒 Security

- No real domains, IPs, hostnames, secrets, or PII in any committed file
- No webhook URLs, debug logs, `.env`-style material in source
- Public list of URLs the user shouldn't see (e.g. internal admin
  panels) — keep them out of catalog READMEs

---

## 🧹 Merge protocol

The global merge rules apply. The reviewer gate includes a security review for every change to
deploy, SSH, secrets or auth. CI on the PR is the Woodpecker check `ci/woodpecker/pr/woodpecker`.

Publishing follows the same rule: once the version-bump PR is merged
and both gates are green, push the release tag without asking (see
"Publish flow" below). JSR versions are immutable, so tag only the
merged bump commit on `main`. Releases are cut in batches (#483):
one version bump and one tag once the work in flight has merged (the end
of a session or a wave), not one per PR, or at once for a security or
data-loss fix. The `publish` step retries a stalled `deno publish` itself,
three attempts of 10 minutes each; restart the pipeline only after all
three fail.

---

## 🚀 Quick reference

```
deno task check             # lint + fmt + type-check + tests
deno task fix               # auto-fix lint + fmt
deno task hooks:install     # install the pre-commit hook

# Backup scripts take their settings from the env file you name:
deno run -A --env-file=<env file> scripts/backup/+main.ts
deno run -A --env-file=<env file> scripts/backup/restore.ts <service>
```

---

## 📦 Releasing — keep versions in sync

The package version is declared in **two places** that must stay
identical:

1. `deno.jsonc` — `version` field. Drives the JSR package version.
2. `cli/version.ts` — `VERSION` export. Drives `rostok --version`.

JSR versions are immutable once published, so a drift between the two
surfaces as `deno.jsonc: 1.0.2` installed while the binary prints
`rostok 1.0.1`. It also breaks
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

Before step 1, run the real-server test on the merged `main` from
your own machine: `deno task e2e:vps local`. It deploys to a fresh
Hetzner Cloud server and deletes it; see "Real-server test" in
`docs/contributing/contributing.md`. It never runs in Woodpecker,
whose logs are public. A failed run: tell the owner what failed.

1. Tag the merge commit and push the tag:
   `git tag v1.0.4 <merge commit> && git push origin v1.0.4`.
2. Woodpecker runs `check` on the tag, then the `publish` step:
   `scripts/release/+main.ts` refuses a tag that differs from
   `deno.jsonc` or `cli/version.ts`, and `deno publish` uses the
   `JSR_TOKEN` repository secret. A failed `check` or guard publishes
   nothing: fix the cause in a PR, then move the tag to the new merge
   commit (`git tag -f`, `git push -f origin <tag>`). If `deno publish`
   itself failed, check jsr.io for the version first: JSR may have
   accepted the upload anyway. An expired or revoked token also fails
   here; replace it as described under "The publish token" below.
3. Verify the new version with `deno install -A --global
   --minimum-dependency-age=0 -n rostok --force jsr:@rostok/cli`
   (the dep-age flag bypasses deno's 24h install delay on fresh
   publishes).
4. `rostok --version` must print the new version. If it prints an
   older one, the install used a stale cache or the tag build did not
   publish: read the tag's Woodpecker log.
5. Run the real-server test again, on the published package:
   `deno task e2e:vps <version>`.

### The publish token

Pushing a `v*` tag publishes. No person approves it, unlike the old
browser flow, where every approval named the package and version.
Whoever can push a tag to this repo (the owner and every agent on the
shared GitHub account) can publish, and a tag build runs the tagged
commit's own `.woodpecker.yml` with the token, even on an unmerged
commit. Woodpecker hides only the token's exact value, and the build
logs of this public repo are public. So:

- Tag only merge commits on `main`; the pipeline does not check it.
- The jsr.io token has "publish" permission for `@rostok/cli` only,
  and an expiry date.
- The Woodpecker secret `JSR_TOKEN` belongs to this repository (not
  the organisation or the server), is allowed for the `tag` event
  only (never `push` or `pull_request`; Woodpecker preselects `push`),
  and has no image filter (Woodpecker refuses image-filtered secrets
  to steps that run commands).
- Keep the Woodpecker webhook URL secret: it carries the token that
  lets GitHub start builds.

If the token leaks or expires: revoke it on jsr.io, create a new one
with the same scope, replace the Woodpecker secret, and check jsr.io
for versions nobody released.

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

- `docs/design/v1-cli.md` — v1 design (shipped; kept as the design record)
- `docs/design/v2-cli.md` — v2 backlog (draft)
- `docs/design/v2-website.md` — future static site (draft)
- `docs/usage/concepts.md` — stack, server, wizard
- `docs/usage/architecture.md` — how the pieces fit
- `docs/usage/catalog.md` — what's in the catalog
- `docs/usage/ENCRYPTED_ENV_FILES.md` — age64 workflow
- `docs/contributing/adding-services.md` — author a stack
- `docs/contributing/contributing.md` — PR checklist for contributors
