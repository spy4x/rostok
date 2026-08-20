# rostok v2 — backlog

This file tracks command/feature ideas that did not fit v1 but are
worth keeping. Pull from here when planning v2+.

v1 is scoped in [`v1-cli.md`](v1-cli.md). Future static-site plans live
in [`v2-website.md`](v2-website.md).

---

## Cross-stack wiring

Adjacency-list on the stack. The dependent stack declares its outgoing
patches.

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

Why deferred: every meaningful cross-stack interaction (Traefik ↔
Authelia middleware, Gatus cross-monitoring) makes `server create` no
longer "minimal". v1 keeps each `stack add` independent. v2 unlocks the
graph.

Resolution order (planned):
1. Server-level vars resolved
2. All target stacks loaded; `+meta.ts` validated
3. Topsort stacks by `dependencies`
4. For each stack in order, run its `connectsTo[*].setup()` against
   already-resolved peer artifacts

Why one direction (each stack owns its outgoing edges): avoids N×M
file proliferation. If both directions are needed (rare), each stack
declares its own outgoing adjacency.

---

## Bulk stack add — `--stacks=<csv>`

`rostok server create home --stacks=traefik,gatus,vaultwarden`. Rejected
for v1 — keeps `server create` simple, makes the UX obvious for
newcomers. v2 reintroduces for power users.

---

## Short command/flag aliases

`rostok server create --non-interactive --name=home` could also be
`rostok s c -n --name=home`. Cliffy supports aliases natively
(`.alias("s")`). v2 adds:

- `i` → `init`
- `s` → `server`
- `c` → `create`, `a` → `add`, `l` → `list`, `rm` → `remove`
- `-y` / `-n` → `--yes` / `--non-interactive`
- `-s` → `--server`
- `-v` → `--var`

---

## Deno auto-install during `rostok init`

Should `rostok init` install Deno on the host machine and the server
machines? Open question.

Arguments for:
- All scripts are Deno. Zero-config onboarding matters for hobbyists.
- `deno install` is one curl pipe; `init` could detect + prompt.

Arguments against:
- Modifying user PATH / installing system packages is heavy.
- Different installers per OS (brew/apt/dnf/scoop).
- Servers may not need Deno at runtime — only deploy/backup scripts do.

Decision deferred. If yes: opt-in via `--install-deno` flag, prompt
otherwise. Likely scoped to the host (not remote servers).

---

## First-run experience

`rostok` with no args in an empty directory → runs `init` interactively
(sensible default template, optional git init, optional telemetry
opt-in). Includes language preference prompt for v3+ i18n.

Also: in an existing project with no servers, suggest
`rostok server create <name>`. In a project with broken config, suggest
`rostok doctor`.

---

## Telemetry

Opt-in only (off by default). Asks during `rostok init`. Tracks:
- `init` invoked (no PII)
- `server create` invoked (server name hash, no IP)
- `stack add` invoked (stack name)

Used only for adoption metrics. Help link to opt out / view what's
collected. Stored in `~/.rostok/telemetry.jsonl`.

Rejected by default. Easy to remove from the codebase if it ever
becomes a liability.

---

## Language preference

Prompt during `init`: "rostok prompts in your language?" Choices: en,
ru, ... Persist in `~/.rostok/config.json`. v1 ships English-only; v2+
loads locale strings.

---

## Conditional variables

`variables[i].when: (ctx) => ctx.serverHasStack("postgres")` — variable
only asked when predicate true. Common for stacks that integrate with
multiple optional peers (e.g. "if Postgres stack present, use it; else
SQLite").

---

## Multi-choice variables

`type: "select"`, `options: ["postgres", "sqlite"]`. Cliffy's
`Select` prompt. Schema validated via arktype enum.

---

## Variable groups

For long wizards, group variables: Network / Auth / Storage /
Monitoring. Progress indicator. v2 only — first stack needing 10+
variables will tell us when this is needed.

---

## `rostok doctor`

Sanity check: age installed, key present, hooks installed, syncthing
reachable, deploy target reachable. Read-only, exit code reflects
health.

---

## `rostok stack remove`

Symmetric to `stack add`. Interactive confirmation, removes stack's
entries from `config.json` and `.env`, stops/removes containers via
existing `deno task deploy`.

---

## `rostok server rename` / `server remove`

Rename a server dir, update references in configs. `remove` archives
under (user-managed) backup; no `.rostok/archive/` dir.

---

## Remote catalog

`rostok --catalog=https://github.com/you/stacks` fetches `+meta.ts` at
runtime. Plugins + private/custom stacks. Pin via `--catalog-ref=v1.2.3`
or a lockfile.

Forks of the upstream catalog become first-class citizens — pick one
at `init` time, update via `rostok catalog update`.

---

## Compiled binaries

`deno compile` per OS/arch, distributed via GH Releases + a
`curl | sh` snippet. Useful for non-Deno users.

---

## Auto-update

Check JSR for newer version, prompt to update. Lands after v1 is
stable on JSR for at least one release cycle.

---

## Templates

`rostok server create home --template=production` pre-fills stricter
defaults (auth on, basic-auth on, monitoring on, backups configured).
Template definitions live in `cli/templates/`.

---

## Stack alias / bundles

`--stacks=tiny` resolves to a curated bundle (traefik, vaultwarden,
gatus) defined in `cli/bundles/`. Power-user shortcut for common
combos.

---

## Dry-run / diff mode

`--dry-run` prints what would be written. `--diff` shows the patch
before applying. Useful for CI / previews.

---

## `rostok stack init`

Scaffold a new `stacks/<x>/+meta.ts` from `compose.yml` introspection.
Detects `${VAR}` references and generates default variable entries.
Trivial to write (text-munging); valuable DX.

---

## `rostok stack lint`

Validates every `+meta.ts` in the catalog (schema, default presence,
secret detection, ${SERVER_NAME} substitution safety).

---

## `rostok stack graph`

Render the full catalog dependency graph as Mermaid / DOT.

---

## `rostok stack show <name>`

Full `+meta.ts` rendered (variables, defaults, secrets). Useful
discovery helper.

---

## i18n

Questions can be in user's locale; `+meta.ts` carries `question`
strings in English for v1, additional languages in v2. Crowdsource via
JSON files keyed by variable key, not full +meta.ts translation.

---

## Rejected (kept here so we don't re-litigate)

- **`stacks/<A>/connections/<B>.ts/`** (N×M file-per-pair) — file
  count grows fast; patch logic belongs with the dependent stack
- **`.env` comment markers (`# @rostok:traefik`)** — fragile to hand
  edits; ownership lives in `+meta.ts` instead
- **Separate manifest file per server**
  (`servers/<n>/.rostok/manifest.json`) — parallel metadata to keep in
  sync; the schema is self-describing
- **`rostok env` subcommand** — out of scope; CLI manages `.env` while
  manipulating servers/stacks
- **Import tool for existing `servers/{home,cloud,offsite}/`** — user
  migrates manually after v1 lands
- **`.rostok/archive/` for `server remove`** — user has `.git`
- **`rostok migrate`** — same reason; not needed