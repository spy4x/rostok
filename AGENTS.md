# AGENTS.md — repo maintainer guide

Guidelines for AI agents and humans maintaining the **rostok** repo:
the catalog of self-hosted services and the CLI tool that scaffolds
users' projects.

The repo's own `servers/` is gone. There is no personal homelab here.
What lives here is a **catalog** (`stacks/`) and the **CLI source**
(`scripts/encryption/`, `scripts/hooks/`, plus the new `cli/` package
in development).

---

## 🟢 Repository layout

```
rostok/
├── stacks/                   # the catalog — one dir per service
│   └── <stack>/
│       ├── compose.yml       # Docker Compose (must use `hl-` prefix)
│       ├── backup.ts         # backup config (skip for stateless)
│       ├── +meta.ts          # CLI schema (READY-TO-IMPLEMENT, see docs/design/v1-cli.md)
│       └── README.md         # what the stack does, how to configure
├── cli/                      # the rostok CLI source (added in v1 phase 2)
├── scripts/
│   ├── encryption/           # age64 — encrypt/decrypt .env ↔ .env.age
│   ├── backup/               # Restic backup system (per-stack backup.ts)
│   └── hooks/                # git hooks (post-checkout, post-merge, pre-commit)
├── docs/                     # CLI docs, catalog, design notes
├── deno.jsonc                # tasks + deps
├── README.md                 # public landing page
├── LICENSE
└── AGENTS.md                 # this file
```

`stacks/` is the catalog — every entry is reusable by any user. Never
hardcode a real domain, IP, or hostname in a stack. The catalog travels
through JSR; it's read by every `rostok` invocation.

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
- Remove `[WIP]` only when complete and ready for review.
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

---

## 🔒 Security

- No real domains, IPs, hostnames, secrets, or PII in any committed file
- No webhook URLs, debug logs, `.env`-style material in source
- Public list of URLs the user shouldn't see (e.g. internal admin
  panels) — keep them out of catalog READMEs

---

## 🧹 Merge protocol

After all changes are done and the PR is created, **STOP and wait**.
Never merge yourself. When the user says "merge":

- All commits relate to one feature → `gh pr merge --squash --delete-branch`
- Some commits fix independent things → `gh pr merge --rebase --delete-branch`

Then clean up:

```bash
cd $(git rev-parse --show-toplevel)
git worktree remove <type>/<short-description>
git branch -d <type>/<short-description>
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
