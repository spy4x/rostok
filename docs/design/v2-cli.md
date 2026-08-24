# rostok v2 — backlog (draft)

**Status:** draft. Not ready for implementation.

v1 ships in [`v1-cli.md`](v1-cli.md). Static-site plans live in
[`v2-website.md`](v2-website.md). This file is a parking lot for ideas
that didn't fit v1.

---

## Deno auto-install (full auto, idempotent)

`$ rostok` ensures Deno is on PATH. If missing, install via the
platform-native path (`brew` on macOS, `apt`/`dnf`/`pacman` on Linux,
`winget`/`choco` on Windows). Modify `PATH` if needed (idempotent — no
op if Deno already installed and reachable).

No flag. Always runs. Ensures the rest of the toolchain works
immediately.

---

## `rostok doctor` runs after `$ rostok`

After the v1 wizard finishes (init + server create + stack add + re-
encrypt), v2 also runs `rostok doctor` to sanity-check the result.

`rostok doctor` standalone is exposed as a subcommand for
ad-hoc verification.

`doctor` checks:
- Deno installed + reachable
- age installed + key present + readable
- `.env.age` decrypts cleanly
- Git hooks installed (if `.git/` present)
- Syncthing reachable (if configured)
- Deploy target SSH-reachable (if configured)

Read-only. Exit code = number of failed checks.

---

## AI-coding-assistant-friendly

Design CLI output, errors, and help text so AI coding assistants can
parse and use them. Concretely:

- **Structured output** — `--format json` on every read-only command
  (`stack list`, `doctor`, etc.). Default for humans is pretty text;
  default for non-TTY is JSON.
- **Actionable errors** — every error message includes the exact
  command or flag to recover. Never just "validation failed" — always
  "missing required var FOO; re-run with `--var FOO=bar`".
- **Self-describing commands** — `--schema` flag on relevant commands
  prints the JSON schema of the output. Helps AI generate code that
  consumes rostok's output.
- **Stable JSON shapes** — once published, JSON output is semver-locked
  per CLI version. AI tools can rely on it.
- **Markdown help** — `--help` output is parseable; `--help --format
  markdown` for embedding in docs.
- **Determinism** — no timestamps or random IDs in default output
  unless asked (`--timestamps` flag). Easier to diff, easier for AI
  to compare.

---

## Cross-stack wiring (adjacency list)

```typescript
// stacks/vaultwarden/+meta.ts
connectsTo: [
  {
    stack: "traefik",
    when: (ctx) => ctx.serverHasStack("traefik"),
    setup: async (ctx) => {
      // patch vaultwarden's compose.yml to add Traefik labels
      // and add a router rule to servers/<n>/configs/traefik/dynamic/
    },
  },
],
```

Each stack owns its outgoing edges. Resolution: topsort by
`dependencies`, run `setup()` against already-resolved peer artifacts.

Deferred because cross-stack interactions (Traefik ↔ Authelia, Gatus
cross-monitoring) make `stack add` no longer independent. v1 keeps
each `stack add` a single-stack operation.

---

## Bulk stack add — `--stacks=<csv>`

Deferred from v1. For non-interactive wizard only — interactive wizard
still picks one stack at a time. Power users today re-run
`$ rostok stack add <name> -s <server>` per stack. v2 adds
`--stacks=foo,bar` so the whole flow finishes in one invocation.

---

## Short command/flag aliases

`rostok server create --non-interactive --name=home` → `rostok s c
--non-interactive --name=home`. Cliffy supports `.alias("s")`. v2 adds:

- `i` → `init` (if reintroduced as a subcommand)
- `s` → `server`
- `c` → `create`, `a` → `add`, `l` → `list`, `rm` → `remove`
- `-n` → `--non-interactive`

---

## Telemetry

Opt-in only (off by default). Asks during `$ rostok` first run, then
remembers the choice in `~/.rostok/config.json`. Tracks:

- `init` invoked (no PII)
- `server create` invoked (server name hash, no IP)
- `stack add` invoked (stack name)

Used only for adoption metrics. Easy to remove from the codebase if it
ever becomes a liability.

---

## Language preference

Prompt during `$ rostok` first run: "rostok prompts in your language?"
Choices: en, ru, ... Persist in `~/.rostok/config.json`. v1 ships
English-only; v2+ loads locale strings. v3 hint = full translation
pipeline.

---

## Conditional variables

`variables[i].when: (ctx) => ctx.serverHasStack("postgres")` —
variable only asked when predicate true. For stacks that integrate
with multiple optional peers.

---

## Multi-choice variables

`type: "select"`, `options: ["postgres", "sqlite"]`. Cliffy's `Select`
prompt. Schema validated via arktype enum.

---

## Variable groups

For long wizards, group variables: Network / Auth / Storage /
Monitoring. Progress indicator. Only when first stack needs 10+
variables.

---

## `rostok stack remove`

Symmetric to `stack add`. Interactive confirmation, removes stack's
entries from `config.json` and `.env`, stops containers via existing
`deno task deploy`.

---

## `rostok server rename` / `server remove`

Rename a server dir, update references. `remove` archives under
user-managed backup. No `.rostok/archive/` (user has `.git`).

---

## Remote catalog

`rostok --catalog=<url>` fetches `+meta.ts` at runtime. Plugins +
private/custom stacks. Pin via `--catalog-ref=v1.2.3` or a lockfile.

Forks of the upstream catalog become first-class citizens.

---

## Compiled binaries

`deno compile` per OS/arch, distributed via GH Releases. Useful for
non-Deno users.

---

## Auto-update

Check JSR for newer version, prompt to update. After v1 stable for one
release cycle.

---

## Templates

`rostok server create home --template=production` pre-fills stricter
defaults. Templates live in `cli/templates/`.

---

## Stack alias / bundles

`--stacks=tiny` resolves to a curated bundle defined in
`cli/bundles/`. Power-user shortcut.

---

## Dry-run / diff mode

`--dry-run` prints what would be written. `--diff` shows the patch
before applying.

---

## `rostok stack init`

Scaffold a new `stacks/<x>/+meta.ts` from `compose.yml` introspection.
Detects `${VAR}` and generates default entries.

---

## `rostok stack lint`

Validates every `+meta.ts` in the catalog (schema, defaults, secret
detection, `${SERVER_NAME}` safety).

---

## `rostok stack graph`

Render the full catalog dependency graph as Mermaid / DOT.

---

## `rostok stack show <name>`

Full `+meta.ts` rendered (variables, defaults, secrets).

---

## i18n

Questions can be in user's locale. v1 carries `question` strings in
English; v2 adds locale files keyed by variable key.

---

## Rejected (kept here so we don't re-litigate)

- **`stacks/<A>/connections/<B>.ts/`** — N×M file proliferation
- **`.env` comment markers (`# @rostok:traefik`)** — fragile to hand
  edits; ownership in `+meta.ts`
- **Separate manifest per server** — parallel metadata
- **Import tool for existing servers** — user migrates manually
- **`.rostok/archive/`** — user has `.git`
- **`rostok migrate`** — not needed
- **Separate `init` subcommand** — folded into `$ rostok`
- **`--yes` / `-y`** — single `--non-interactive` / `-n` is enough
- **`.env.example` files** — schema lives in `+meta.ts`