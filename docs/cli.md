# rostok CLI — backlog

This file tracks command/feature ideas that did not fit v1 but are
worth keeping. Pull from here when planning v2+.

## Candidate v2 commands

- `rostok server rename <old> <new>` — rename a server dir, update
  references in configs
- `rostok server remove <name>` — interactive confirmation, archives
  server dir under `.rostok/archive/`
- `rostok stack remove <name> --server=<n>` — symmetric to `stack add`
- `rostok doctor` — sanity check: age installed + key present, hooks
  installed, syncthing reachable, deploy target reachable
- `rostok stack list --installed --server=<n>` — show only stacks
  currently in `servers/<n>/config.json`
- `rostok stack show <name>` — full `+meta.ts` rendered (variables,
  connections, defaults)
- `rostok env decrypt|encrypt` — thin wrappers over `deno task env:*`
  for when users only have the binary, not the repo
- `rostok update` — check for newer rostok version, self-update

## Distribution & ecosystem

- **Remote catalog** — `rostok --catalog=https://github.com/you/stacks`
  fetches `+meta.ts` at runtime. Plugins + private/custom stacks
  become possible. Pin via `--catalog-ref=v1.2.3` or a lockfile.
- **Compiled binaries** — `deno compile` per OS/arch, distributed via
  GH Releases + a `curl | sh` snippet. Useful for non-Deno users.
- **Auto-update** — check JSR for newer version, prompt to update
- **Plugin manifest** — third-party `+meta.ts` discovery

## UX enhancements

- **Dry-run mode** — `rostok server create home --stacks=traefik --dry-run`
  prints what would be written, writes nothing
- **Diff mode** — `rostok stack add traefik --server=home --diff`
  shows what would change before applying
- **Templates** — `rostok server create home --template=production`
  pre-fills stricter defaults (auth on, basic-auth on, monitoring on)
- **Stack alias** — `--stacks=tiny` resolves to a curated bundle
  (traefik, vaultwarden, gatus) defined in `cli/bundles/`
- **First-run experience** — `rostok` with no args detects empty repo
  and runs `server create` interactively

## DX enhancements

- **`rostok stack init`** — scaffold a new `stacks/<x>/+meta.ts` from
  compose.yml introspection. Detects `${VAR}` references and generates
  default variable entries.
- **`rostok stack lint`** — validates every `+meta.ts` in the catalog
  (schema, default presence, secret detection)
- **`rostok stack graph`** — render the full catalog dependency graph
  as Mermaid / DOT
- **`rostok migrate`** — migrate hand-curated `servers/<n>/` to the
  manifest format (deferred per design — user migrates manually)

## Static website (docs/website.md)

- Single source of truth: `README.md` + `docs/*.md`
- Renderer: Fresh 2 / Astro / Next — pick when we get there
- No hardcoded copy in site code
- Built and hosted on GH Pages or Cloudflare Pages
- Sections mirror docs structure; permalink per page

## Schema extensions

- **Conditional variables** — `variables[i].when: (ctx) => ctx.serverHasStack("postgres")`
- **Multi-choice variables** — `type: "select"`, options from
  `+meta.ts`
- **Variable groups** — for a 30-question wizard, group by topic
  (Network, Auth, Storage, Monitoring) with progress indicator
- **Per-stack docs** — `stacks/<x>/README.md` is already present;
  CLI could show excerpts in `stack show`

## Cross-cutting concerns

- **i18n** — questions can be in user's locale; `+meta.ts` carries
  `question` strings in English only for v1
- **Telemetry** — opt-in, anonymous, count of `server create`
  invocations. Helps measure adoption. Add only if asked.
- **Telemetry for errors** — same, opt-in, helps triage bugs. Add only
  if asked.

## Rejected (kept here so we don't re-litigate)

- **`stacks/<A>/connections/<B>.ts/`** (N×M file-per-pair) — file
  count grows fast; patch logic belongs with the dependent stack
- **`.env` comment markers (`# @rostok:traefik`)** — fragile to hand
  edits; ownership lives in `+meta.ts` instead
- **Separate manifest file per server** (`servers/<n>/.rostok/manifest.json`)
  — parallel metadata to keep in sync; the schema is self-describing
- **`rostok env` subcommand** — out of scope; CLI manages `.env` while
  manipulating servers/stacks
- **Import tool for existing `servers/{home,cloud,offsite}/`** —
  user migrates manually after v1 lands