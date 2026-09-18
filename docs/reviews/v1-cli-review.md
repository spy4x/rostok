# v1 CLI code review

**Scope:** all of `cli/` (the rostok CLI package, currently published at
`jsr:@rostok/cli@1.0.3`), plus the integration seams into the
pre-existing `scripts/deploy/`, `scripts/ansible/`, `stacks/*` that the
CLI reads from / writes to.

**Method:** read-only review against `origin/main` at
`b425f20 fix(mig): build from local source, image tag mig:latest`.
All 191 tests pass; `deno task check` clean.

**Bottom line:** the CLI shape is solid — arktype/cliffy composition
is clean, encryption integration is good, public API surface
(`@rostok/cli/lib`) is well-bounded. The blocking issues are all in
the **seam** between `cli/server-create.ts` and the pre-existing
`scripts/deploy/*` + `stacks/*`: three values the v1 design forgot
to consolidate (`PATH_APPS`, `USER`, server-name validation). Fix
those and a fresh `rostok → rostok deploy` actually works
end-to-end.

---

## Findings index

| # | Severity | Area | Title |
|---|---|---|---|
| 1 | 🔴 P0 | deploy seam | `PATH_APPS` never written by wizard |
| 2 | 🔴 P0 | deploy seam | `USER` vs `HOMELAB_USER` mismatch |
| 3 | 🔴 P0 | input validation | path traversal on `serverName` / `--catalog` |
| 4 | 🟡 P1 | CLI parser | `parseVarFlags` cycle-handling silently drops inputs |
| 5 | 🟡 P1 | .env format | quote-stripping is asymmetric between modules |
| 6 | 🟡 P1 | security | decryption error leaks ciphertext prefix |
| 7 | 🟡 P2 | perf | `encryptEnvFiles` uses sync I/O in async loop |
| 8 | 🟡 P2 | embed safety | `_hintShown` / `_pathCache` are process-global |
| 9 | 🟡 P2 | .env format | `parseEnv` silently drops malformed lines |
| 10 | 🟡 P2 | input validation | `config.json` shape not structurally validated |
| 11 | 🟢 P3 | UX | typo in `${KEY}` reference silently passes validation |
| 12 | 🟢 P3 | refactor | `catalog.ts` / `catalog-paths.ts` split is confusing |
| 13 | 🟢 P3 | refactor | `findEnvFiles` / `findAgeFiles` near-duplicate |
| 14 | 🟢 P3 | refactor | `findEnvFiles` regex `/^\.env/` is too broad |
| 15 | 🟢 P3 | refactor | `commands/env.ts` is 4 subcommands in 1 file |
| 16 | 🟢 P3 | refactor | `encrypt.ts` is 5 concerns in 1 file |
| 17 | 🟢 P3 | refactor | `init.ts` mixes 3 responsibilities |
| 18 | 🟢 P3 | refactor | `updateServerConfig` private fn in stack-add.ts |
| 19 | 🟢 P3 | perf | `mergeEnv` is O(n²) |
| 20 | 🟡 P2 | embed safety | `_pathCache` cache never invalidates |
| 21 | 🟢 P3 | dead code | `formatCatalogSummary` unused |
| 22 | 🟢 P3 | dead code | `safeReadPublicKey` untested + dead-ish |
| 23 | 🟢 P3 | regex | `getAgePublicKey` greedy `(.+)` |
| 24 | 🟢 P3 | collision | `SKIP = "__skip__"` sentinel |
| 25 | 🟢 P3 | UX | `--var` parse error lacks flag index |
| 26 | 🟡 P2 | tests | no version-drift regression test |
| 27 | 🟡 P2 | tests | catalog / `+meta.ts` / `deno.jsonc` drift |
| 28 | 🟢 P3 | tests | `server-create.test.ts` / `stack-add.test.ts` missing |

---

## 🔴 P0 — blocking bugs

### #1 `PATH_APPS` never written by the wizard

**Files:** `scripts/deploy/+main.ts:37-42`, `cli/server-create.ts:218-222`

`scripts/deploy/+main.ts:41` requires `PATH_APPS` to be set in
`servers/<n>/.env`:

```ts
if (!SSH_ADDRESS || !PATH_APPS) {
  error(`SSH_ADDRESS and PATH_APPS must be set in ${targetEnvPath}`)
  Deno.exit(1)
}
```

The wizard's server-create step only prompts for `VOLUMES_PATH`
(`cli/server-create.ts:218-222`) — `PATH_APPS` is never prompted, never
written, never migrated from `.env.root`.

**Reproduction:**

```sh
mkdir /tmp/rostok-review && cd /tmp/rostok-review
git init && deno run -A jsr:@rostok/cli -n \
  --var serverName=home \
  --var sshTarget=homelab \
  --var user=deploy \
  --var domain=example.test \
  --var contactEmail=ops@example.test
# wizard completes successfully
deno run -A jsr:@rostok/cli deploy home
# → "SSH_ADDRESS and PATH_APPS must be set in .../servers/home/.env"
```

Every fresh `rostok` user hits this on first deploy.

**Fix options:**

- **A (smallest diff):** add `PATH_APPS` prompt to `collectInput()` with
  a default derived from `VOLUMES_PATH` (`${VOLUMES_PATH}/apps`) and
  add it to the `incoming` array in `serverCreate()`.
- **B (cleaner):** consolidate — drop `PATH_APPS` as a separate value,
  have `scripts/deploy/+main.ts` compute it. The ansible inventory
  (`scripts/ansible/inventory.ts:104`) already defaults to `~/apps`,
  so this is a real convention split that v1 should resolve.

Either way, add a regression test that runs `serverCreate()` and
asserts `PATH_APPS` (or the chosen equivalent) is in the written
`.env`.

---

### #2 `USER` vs `HOMELAB_USER` mismatch — silent wrong-user deploy

**Files:** `cli/server-create.ts:86`, `scripts/deploy/+main.ts:39`,
`scripts/ansible/inventory.ts:91`, `stacks/syncthing/before.deploy.ts:246`

`cli/server-create.ts:86` writes:

```ts
...(input.user ? [{ key: "USER", value: input.user }] as EnvEntry[] : []),
```

But every consumer reads `HOMELAB_USER`:

```ts
// scripts/deploy/+main.ts:39
const HOMELAB_USER = targetEnv["HOMELAB_USER"] || "homelab"
```

```ts
// scripts/ansible/inventory.ts:91
let user = Deno.env.get("HOMELAB_USER") || "homelab"
```

```ts
// stacks/syncthing/before.deploy.ts:246
return Deno.env.get("HOMELAB_USER") ?? "spy4x"
```

The comment at `cli/server-create.ts:9-11` claims the deploy scripts
"translate" — there is no translation; the deploy script is unchanged.
Every wizard user gets `USER` ignored and `chown -R homelab` (or
`spy4x`) ran on the wrong account.

**Fix:** pick one canonical name. `scripts/backup/+main.ts:2` already
imports `USER` from `./src/+lib.ts`, so `USER` is the convention
forward. Update:

- `scripts/deploy/+main.ts:39` → `const USER = targetEnv["USER"] || "homelab"`
- `scripts/ansible/inventory.ts:91` → `let user = Deno.env.get("USER") || "homelab"`
- `stacks/syncthing/before.deploy.ts:246` → same
- All `.env` template files that document `HOMELAB_USER` (none in
  repo; this is the time to check)

Add a regression test in `cli/e2e/smoke.test.ts` that runs
`serverCreate()` and asserts `USER=...` appears (no `HOMELAB_USER`).

---

### #3 Path traversal on `serverName` and `--catalog`

**Files:** `cli/server-create.ts:77,149`, `cli/stack-add.ts:74,111,173`,
`cli/catalog-paths.ts:20-48`

`serverName` validator only checks `length > 0`:

```ts
// cli/server-create.ts:146-150
const serverName = await ask(
  "serverName",
  "home",
  (v) => (v.trim().length > 0 ? true : "server name required"),
)
```

`--catalog` is walked as a directory with no validation:

```ts
// cli/catalog-paths.ts:24
for await (const entry of Deno.readDir(catalogDir)) {
  if (entry.isDirectory) subdirs.push(entry.name)
}
```

**Reproduction (informational, do not run on real infra):**

```sh
rostok server create '../etc'    # writes servers/../etc/.env
rostok stack list --catalog=/etc  # walks /etc
```

**Fix:**

- `serverName`: regex `/^[a-z0-9_-]+$/i` in the validator. Same regex
  used for `project` (`cli/server-create.ts:196`) — apply uniformly.
- `--catalog`: reject if `catalogDir` is absolute or contains `..`
  segments. Or canonicalize via `realPath` and verify it's a child of
  `cwd` / `Deno.cwd()`.
- Add unit tests for both rejection paths.

---

## 🟡 P1 — should fix before next patch release

### #4 `parseVarFlags` cycle-handling silently drops inputs

**File:** `cli/+main.ts:144-172`

The walker:

```ts
const seen = new WeakSet<object>()
const walk = (v: unknown, depth: number) => {
  if (typeof v === "string") { flat.push(v); return }
  if (depth > 4 || v === null || typeof v !== "object") return
  if (seen.has(v as object)) return   // cycle — stop, silently
  seen.add(v as object)
  if (Array.isArray(v)) {
    for (const x of v) walk(x, depth + 1)
  }
}
```

If cliffy emits `["A=1", "B=2", <backref>, <backref>]` the second
`<backref>` consumes one slot and is dropped on the cycle check.
Net effect: **a flag value can be silently lost** and the user gets
no warning.

The test only covers the happy path
(`cli/+main.test.ts:135-148`). It does not cover dedupe semantics.

**Fix:** ditch `<kv...:string[]>` + `collect: true` — use:

```ts
.option("--var <val:string>", "repeatable; overrides one variable (KEY=VAL)", {
  collect: true,
})
```

Cliffy emits a flat `string[]`, no circular ref. Or normalize to a
`Set<string>` to dedupe explicitly. Either way, document the dedupe
contract in the test name.

---

### #5 Quote-stripping is asymmetric — `.env` round-trips corrupt values

**Files:** `cli/age.ts:156-161`, `cli/env-files.ts:19-31`,
`cli/encrypt.ts:240`

`parseEnvFile` (used by encryption) strips one layer of matched
single/double quotes:

```ts
// cli/age.ts:156-161
if (
  (value.startsWith('"') && value.endsWith('"')) ||
  (value.startsWith("'") && value.endsWith("'"))
) {
  value = value.slice(1, -1)
}
```

`parseEnv` (used by server-create / stack-add) does **not** strip
quotes. Same `.env` file parses differently depending on which module
reads it.

`cli/encrypt.ts:240` writes `${e.key}=${value}` with no quoting. If
a stack default returns `"hello world"`, the next encrypt pass reads
it as `value: "\"hello world\""` and re-encrypts with the quotes
baked in. Round-trip drift accumulates.

**Fix:** standardize on a single `.env` parser.

- Option A: drop `parseEnvFile` quote-stripping (match `env-files.ts`)
  and require stack authors to not quote.
- Option B: have `env-files.ts` strip too — preserve current
  `parseEnvFile` behavior.

Pick one. Tests in `env-files.test.ts` (currently covers parseEnv
round-trip without quotes) and the encryption tests need to match.

---

### #6 Decryption error leaks ciphertext prefix

**File:** `cli/age.ts:109`

```ts
throw new Error("Not an age64 value: " + age64Value.slice(0, 20))
```

First 20 chars of base64 ciphertext end up in stderr. Not a secret
leak per se (it's already encrypted), but noisy and a precedent for
echoing input back in errors.

**Fix:** drop the slice. `Not an age64 value.` is enough. Same for
`cli/age.ts:124` "age decrypt failed" — wrap stderr to single line,
don't echo `age64:` values back.

---

## 🟡 P2 — fix opportunistically

### #7 `encryptEnvFiles` uses sync I/O in async loop

**File:** `cli/encrypt.ts:176-177`

```ts
const newContent = Deno.readTextFileSync(envPath)
const oldContent = await exists(agePath) ? Deno.readTextFileSync(agePath) : ""
```

Blocks the event loop per file. On a multi-server project with 20+
`.env` files, 20+ sync I/O stalls. Switch to async equivalents.

---

### #8 `_hintShown` is process-global

**File:** `cli/encrypt.ts:96`

```ts
const _hintShown = new Set<string>()
```

Fine for one CLI invocation. If the CLI is ever imported as a library
(`@rostok/cli/lib` is published — see `cli/+lib.ts`), hints never
reset between tests or between embedded invocations. Make it scoped
to a passed-in context object, or accept a `quiet?: boolean` flag.

---

### #9 `parseEnv` silently drops malformed lines

**File:** `cli/env-files.ts:24`

```ts
const eq = line.indexOf("=")
if (eq < 0) continue  // silently dropped
```

`KEYVALUE` becomes a comment in the output. Combined with the write
that joins `key=value` verbatim, you can produce an `.env` that
compose happily reads but is malformed.

**Fix:** log a warning when dropping a line, or assert
`eq >= 0` and require a key=value shape.

---

### #10 `config.json` shape not structurally validated on read

**File:** `cli/stack-add.ts:175-185`, `cli/commands/deploy.ts:60`

```ts
// cli/stack-add.ts:175-185
let cfg: ConfigFile = { stacks: [] }
try {
  const text = await Deno.readTextFile(configPath)
  cfg = JSON.parse(text)
  if (!Array.isArray(cfg.stacks)) cfg.stacks = []
}
```

The parsed object's `stacks[].name` is trusted — never type-checked.
`validateDeployArgs` reads the same file. Use a real schema
(`validateStackMeta`-style) before mutating.

---

### #11 Typo in `${KEY}` reference silently passes validation

**File:** `cli/defaults.ts:64-67`

```ts
return typeof v === "string" ? v : match   // unknown passes through verbatim
```

Intentional — `compose` then sees `${DOMIAN}` and surfaces a startup
error (the debugging signal). But `unsupportedReferences` only checks
against the allow-list, not for `DOMIAN`-like typos in a value that
*is* on the allow-list.

**Fix (optional):** in `validateStackMeta`, after the allow-list
check, run Levenshtein against the allow-list and surface "did you
mean `${DOMAIN}`?" if distance ≤ 2.

---

### #20 `_pathCache` cache never invalidates

**File:** `cli/shell.ts:7`

```ts
const _pathCache = new Map<string, boolean>()
```

Same concern as #8. In a long-lived embed, "is git on PATH?" cached
result never invalidates if PATH changes. Acceptable for one-shot
CLI; document.

---

## 🟢 P3 — refactor + nits

### #12 `catalog.ts` / `catalog-paths.ts` split is confusing

**Files:** `cli/catalog.ts`, `cli/catalog-paths.ts`

Two modules both load `CatalogEntry[]`. `resolveCatalog` uses
`await import("./catalog.ts")` to break a "circular dep" that
doesn't actually exist (`catalog-paths.ts` imports `findStack` from
`catalog.ts` — fine, one-way). The "lazy import" comment
(`cli/catalog-paths.ts:55`) is misleading.

`findStack` is re-exported from `catalog-paths.ts` as
"legacy callers" but no callers use the re-export.

**Fix:** merge `catalog-paths.ts` into `catalog.ts`. Drop the
re-export. Drop the lazy import. One file, ~120 lines, no split-brain.

---

### #13 `findEnvFiles` / `findAgeFiles` are near-duplicates

**File:** `cli/age.ts:183-240`

Same walker, different matcher. Two copies of `isNestedCheckout` +
recursion guard.

**Fix:** one generic `walkDir(rootDir, matchFile)` with a predicate.
Pass `isEnvFile` vs `isEnvAgeFile`. ~40 lines saved.

---

### #14 `findEnvFiles` regex `/^\.env/` is too broad

**File:** `cli/age.ts:185`

```ts
await walkEnvDir(rootDir, results, /^\.env/)
```

A file named `.envtest` matches. `isEnvAgeFile` already encodes the
right predicate (`endsWith(".age") && includes(".env")`). Use the
same logic.

---

### #15 `commands/env.ts` is 4 subcommands in 1 file

**File:** `cli/commands/env.ts` (183 lines)

Four `new Command()` builders + a wrapper. Easy split:
`commands/env/encrypt.ts`, `commands/env/decrypt.ts`,
`commands/env/status.ts`, `commands/env/setup.ts`,
`commands/env/+command.ts`.

---

### #16 `encrypt.ts` is 5 concerns in 1 file

**File:** `cli/encrypt.ts` (328 lines)

age keygen, age64 rendering, env encryption, env decryption, status.
Suggest `age-keygen.ts` (~54), `age64-render.ts` (~90),
`env-encrypt.ts` + `env-decrypt.ts` (~80 each), `env-status.ts`
(~30). Re-export from `encrypt.ts` for back-compat, then deprecate.

---

### #17 `init.ts` mixes 3 responsibilities

**File:** `cli/init.ts` (196 lines)

Skeleton creation + git init + age endorsement. Split as
`init-skeleton.ts`, `init-git.ts`, `init-age-prompt.ts`. Each
under 60 lines.

---

### #18 `updateServerConfig` is a private fn in `stack-add.ts`

**File:** `cli/stack-add.ts:172-186`

Belongs in its own `config-store.ts`. Likely also needs
`removeStack(serverDir, stackName)` (v2 territory, but stub the
interface now).

---

### #19 `mergeEnv` is O(n²)

**File:** `cli/env-files.ts:48-50`

```ts
for (const e of existing) {
  if (incoming.some((i) => i.key === e.key)) {
    continue
  }
  ...
}
```

Build a `Set` of incoming keys first: `O(n + m)`. Trivial cost in
practice (~30 vars typical), mention only.

---

### #21 Dead code: `formatCatalogSummary`

**File:** `cli/catalog.ts:82`

```ts
export function formatCatalogSummary(entries: CatalogEntry[]): string {
```

Never called. Delete.

---

### #22 Dead-ish: `safeReadPublicKey`

**File:** `cli/encrypt.ts:86`

```ts
async function safeReadPublicKey(keyPath: string): Promise<string | undefined> {
  try {
    const text = await Deno.readTextFile(keyPath)
    return text.match(/# public key: (\S+)/)?.[1]
  } catch { return undefined }
}
```

Reached only when `age-keygen` stdout is empty — extreme edge case.
Either remove or add a regression test that monkey-patches the
stdout matcher to fail.

---

### #23 `getAgePublicKey` regex matches greedy `(.+)`

**File:** `cli/age.ts:69`

```ts
const match = content.match(/# public key: (.+)/)
```

If a key file contains multiple `# public key:` lines (corruption,
or someone manually appends one), the last wins. Anchor to start of
line: `/^# public key: (\S+)/m`.

---

### #24 `SKIP = "__skip__"` sentinel

**File:** `cli/wizard.ts:107`

Collides if any future stack is ever named `__skip__`. Low risk, but
use a namespaced sentinel (`@@rostok/skip@@`).

---

### #25 `--var` parse error lacks flag index

**File:** `cli/+main.ts:170`

```ts
throw new Error(`--var requires KEY=VAL form, got: ${f}`)
```

If user types `rostok --var SERVER_NAME foo` (forgot the equals),
`f` is whatever cliffy gives the walker. The user can't easily map
the error back to which `--var` instance was wrong. Wrap with an
index: `--var flag ${i + 1}`.

---

## 🟡 P2 — tests gap

### #26 No version-drift regression test

**Files:** `cli/version.ts:5`, `deno.jsonc:140`

AGENTS.md explicitly warns about `cli/version.ts:VERSION` vs
`deno.jsonc:version` drift ("Phase 10 shipped this state"). No test
enforces it.

**Fix:** add to `cli/+main.test.ts`:

```ts
Deno.test("version: cli/version.ts matches deno.jsonc", async () => {
  const denoJsonc = JSON.parse(await Deno.readTextFile("../deno.jsonc"))
  assertEquals(VERSION, denoJsonc.version)
})
```

---

### #27 catalog / `+meta.ts` / `deno.jsonc` drift

**Files:** `deno.jsonc:148-176`, `cli/catalog.ts:24-29`

Adding a new stack means editing 3 files (create `+meta.ts`, add
import to `catalog.ts`, re-include in `deno.jsonc` `publish.exclude`).
The comment at `deno.jsonc:148-156` acknowledges this.

**Fix:** add a `deno task catalog:check` task that walks
`stacks/*/+meta.ts` and asserts every one is in both `catalog.ts`
and `deno.jsonc`. Run on pre-commit.

---

### #28 `server-create.test.ts` / `stack-add.test.ts` missing

**Files:** referenced in `docs/design/v1-cli.md §10`, don't exist.

Currently only covered by `cli/e2e/smoke.test.ts`. Splitting smoke →
unit would catch the `USER` / `PATH_APPS` / path-traversal bugs
faster.

Suggested coverage:

- `server-create.test.ts`: each input field has its own test
  (validator behavior, default fallback, non-interactive bypass).
- `stack-add.test.ts`: variable merging, ownership preservation,
  server-context propagation.

---

## Nits / style

- `cli/+main.ts:34` `// deno-lint-ignore no-explicit-any`
  `buildCommand(): any` — consider `ReturnType<typeof Command>` or
  a local `type RostokCommand`.
- `cli/server-create.ts:86` spread cast `[{ key: "USER", ... }] as EnvEntry[]`
  — `EnvEntry` already has the shape; cast is redundant.
- `cli/defaults.ts:81-88` `isAllowedRef` uses
  `ref.startsWith("${")` despite already inside the regex
  `\$\{[^}]+\}` — dead check.
- `cli/encrypt.ts:55` `.catch(() => {})` on `Deno.mkdir` swallows
  real errors (EACCES, ENOSPC) silently. At least log on
  `err instanceof Error`.
- `cli/commands/list.ts:33-37` `varCountSuffix` reads as a tiny
  helper for one caller; inline.
- `cli/commands/deploy.ts:120`
  `Deno.exit(out.success ? 0 : (out.code ?? 1))` — `out.success`
  is already `boolean`; the fallback chain is slightly redundant.
- `cli/catalog-paths.ts:62` `pathToFileUrl` doesn't handle Windows
  paths (`C:\...`) correctly. The repo is Linux-only per AGENTS.md,
  so this is acknowledged scope, but worth a comment.

---

## Recommended PR sequence

| Priority | Issue | Effort |
|---|---|---|
| 🔴 P0 | #1 PATH_APPS prompt/write | S |
| 🔴 P0 | #2 USER/HOMELAB_USER rename | M (script update + tests) |
| 🔴 P0 | #3 serverName/--catalog validation | S |
| 🟡 P1 | #4 parseVarFlags simplify | S |
| 🟡 P1 | #5 quote-stripping unify | S |
| 🟡 P1 | #12 merge catalog.ts + catalog-paths.ts | S |
| 🟢 P2 | #13-16 split encrypt/env into focused files | M |
| 🟢 P2 | #26 version-drift test | XS |
| 🟢 P2 | #27 catalog:check task | S |

P0 fixes are mutually independent — can ship in three small PRs.
P1 fixes depend on P0 (catalog merge should land before parseVarFlags
simplification, since the latter touches the main entry).
