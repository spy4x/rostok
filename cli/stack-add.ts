// Stack addition flow.
//
// Per docs/v1-cli.md §3.1 step 3:
//
//   1. Pick a stack from the bundled catalog.
//   2. Run that stack's variable flow (for each VariableSpec: --var
//      override > existing .env value (this covers a stack-declared key
//      that's also a server key, e.g. CONTACT_EMAIL, once server create
//      has written it) > function default > string default >
//      prompt-or-skip).
//
// Writes `servers/<name>/.env` and updates `servers/<name>/config.json`.
// Re-encrypts `.env` to `.env.age` at the end.
//
// #210: all stacks on a server share one `.env`. A value already there
// (written by an earlier `stack add`, or by `server create`) is kept
// unless the caller passes `--var` for that key — so re-running never
// clobbers another stack's key and never rotates an existing secret
// (`() => generatePassword()` only runs when the key is absent or
// blank: #450 treats `KEY=` like a missing key).

import { join } from "@std/path"
import { reencryptAfterWrite } from "./reencrypt.ts"
import {
  decodeEnvValue,
  encodeEnvValue,
  type EnvEntry,
  readEnvFile,
  serverContextFromRoot,
  writeEnvFilePreservingFormat,
} from "./env-files.ts"
import { type CatalogEntry, findStack } from "./catalog.ts"
import { resolveCatalog } from "./catalog-paths.ts"
import { decidePrompt } from "./prompt-rule.ts"
import { resolveVariable } from "./defaults.ts"
import { normalizeVariableSpec } from "./stack-meta.ts"
import type { VariableSpec } from "./stack-meta.ts"
import {
  type ConfirmFn,
  defaultConfirmFn,
  type PromptFn,
  promptValue,
  withKeyLabel,
} from "./prompts.ts"
import { hasReservedStackKeyPrefix, serverDirFor, stackKeyPrefix } from "./server-keys.ts"
import { serverNotFoundMessage, UserError } from "./errors.ts"
import type { resolveStackFiles } from "./deploy/stack-files.ts"
import { type ComposeImage, ComposeReadError, stackImages } from "./images/compose-images.ts"
import { pinImages } from "./images/pin.ts"
import { resolveImagePolicy } from "./images/policy.ts"
import { createRegistryClient } from "./images/registry.ts"

/** Result of a stack-add invocation. */
export interface StackAddResult {
  stackName: string
  serverName: string
  /** Variables actually written (after applying the prompt rule). */
  writtenEntries: EnvEntry[]
  /** Variables that were skipped (required:false, no default). */
  skippedKeys: string[]
  /** Keys written for the first time by this run. */
  newCount: number
  /** Keys that already had a value, kept unchanged. */
  keptCount: number
  /**
   * `requires` dependencies that were missing and the user (interactively)
   * chose not to add. Callers use this to steer {@link buildNextSteps}'s
   * "add this first" suggestion — empty when every requirement was met or
   * auto-added (non-interactive mode never declines).
   */
  declinedRequires: string[]
}

export interface StackAddOptions {
  /** Project root. */
  cwd?: string
  /** Bundled catalog directory (defaults to <cwd>/../stacks in dev mode). */
  catalogDir?: string
  /** Per-variable overrides from --var KEY=VAL. */
  providedVars?: Record<string, string>
  /** Non-interactive: skip prompts; fail on any variable that can't be resolved. */
  nonInteractive?: boolean
  /** Skip server-level propagation (testing only). */
  skipServerPropagation?: boolean
  /** Test injection point for every interactive variable prompt — see prompts.ts's PromptFn. */
  promptFn?: PromptFn
  /** Test injection point for the "add this required stack now?" yes/no prompt. Defaults to cliffy's Confirm.prompt. */
  confirmFn?: ConfirmFn
  /** Test injection point for the registry lookups and the compose download that pin image tags. Defaults to the global `fetch`. */
  fetch?: typeof fetch
  /** Test injection point: where a shipped stack's files are. Defaults to the resolver `rostok deploy` uses. */
  resolveStackFiles?: typeof resolveStackFiles
  /**
   * Internal — used by stackAdd's own `requires` recursion to detect a
   * cycle (`a` requires `b`, `b` requires `a`). Names of stacks already
   * being added higher up the current call chain. Never set this
   * yourself; stackAdd manages it when it recurses for a dependency.
   */
  _visiting?: Set<string>
}

/**
 * Add a stack to a server. Loads catalog, resolves variables against the
 * server context, writes `servers/<name>/.env` + `config.json`, and
 * re-encrypts.
 */
export async function stackAdd(
  stackName: string,
  serverName: string,
  opts: StackAddOptions = {},
): Promise<StackAddResult> {
  const cwd = opts.cwd ?? Deno.cwd()

  // #208: validate the server name before touching the filesystem.
  const serverDir = serverDirFor(cwd, serverName)
  const envPath = join(serverDir, ".env")

  // #210: a missing server fails loudly and writes nothing — stack add
  // never creates a server implicitly.
  const serverExists = await Deno.stat(envPath).then((s) => s.isFile).catch(() => false)
  if (!serverExists) {
    throw new UserError(serverNotFoundMessage(serverName, envPath))
  }

  const catalog = await resolveCatalog(opts.catalogDir)
  const entry = findStack(catalog, stackName)

  // Same check `validateStackConfigs` (cli/deploy/validate-stack-config.ts)
  // makes at deploy time, run here too so a reserved-prefix stack is
  // refused at `stack add` instead of only failing later, at deploy, once
  // it's already in config.json — its own key-prefix would let its
  // .env-sourced keys collide with names tools a hook spawns treat
  // specially (GIT_, DOCKER_, SSH_, ...).
  if (hasReservedStackKeyPrefix(entry.name)) {
    throw new UserError(
      `stack "${entry.name}": its own key prefix "${
        stackKeyPrefix(entry.name)
      }" is reserved — rename the stack.`,
    )
  }

  // Review fix — a requires cycle (a requires b, b requires a) would
  // otherwise recurse forever. `_visiting` tracks every stack name
  // already being added higher up the current call chain; a name
  // reappearing here means a cycle, reported as a UserError naming the
  // full chain instead of blowing the stack. An unknown required stack
  // (not in the catalog at all) is caught for free: the recursive
  // stackAdd call below reaches `findStack` for that name and throws
  // its own "not found in catalog" UserError.
  const visiting = opts._visiting ?? new Set<string>()
  if (visiting.has(stackName)) {
    throw new UserError(
      `requires cycle: ${[...visiting, stackName].join(" -> ")}`,
    )
  }
  visiting.add(stackName)

  // #212 point 1 — a stack that `requires` another one (e.g. every web
  // stack requires traefik) gets that dependency added first, on the
  // same server, before its own variables are resolved. Non-interactive
  // mode adds it automatically and says so; interactive mode asks.
  const missingRequires = await unmetRequires(serverDir, entry)
  const declinedRequires: string[] = []
  const confirmFn = opts.confirmFn ?? defaultConfirmFn
  for (const requiredName of missingRequires) {
    if (opts.nonInteractive) {
      console.log(
        `rostok: ${stackName} requires '${requiredName}', which isn't on ${serverName} yet — adding it first.`,
      )
      await stackAdd(requiredName, serverName, {
        ...opts,
        nonInteractive: true,
        _visiting: visiting,
      })
      continue
    }
    const shouldAdd = await confirmFn({
      message:
        `${stackName} requires '${requiredName}', which isn't on '${serverName}' yet. Add it now?`,
      default: true,
    })
    if (shouldAdd) {
      await stackAdd(requiredName, serverName, { ...opts, _visiting: visiting })
    } else {
      declinedRequires.push(requiredName)
      console.log(
        `rostok: skipped adding '${requiredName}' — ${stackName} may not work until you run ` +
          `rostok stack add ${requiredName} -s ${serverName}`,
      )
    }
  }

  const existing = await readEnvFile(envPath)
  // #450: a key that is present but blank (`KEY=`, `KEY=""`) counts as
  // missing, so its default fills it as it would fill an absent key.
  const existingByKey = new Map(
    existing.filter((e) => decodeEnvValue(e.value).trim() !== "").map((e) => [e.key, e.value]),
  )

  // Build server context from `servers/<server>/.env` (per-server vars),
  // for `${DOMAIN}`-style substitution in string defaults. SERVER_NAME
  // isn't a key any `.env` ever stores (it's the directory name), so it's
  // added explicitly — otherwise the one reference the design doc
  // guarantees (`${SERVER_NAME}`) could never resolve.
  const ctx = opts.skipServerPropagation
    ? null
    : { ...serverContextFromRoot(existing), SERVER_NAME: serverName }

  // #340: under IMAGE_POLICY=pinned, the stack's tag variables get the
  // exact version instead of their floating default — see the pin step
  // after the variable loop. Read before anything is resolved, so a bad
  // IMAGE_POLICY value fails before any prompt.
  const pinned = await resolveImagePolicy(cwd, serverName) === "pinned"
  let images: ComposeImage[] = []
  /** True when the stack's compose file could not be downloaded, so its tag variables are unknown. */
  let composeUnread = false
  if (pinned) {
    try {
      images = await stackImages(cwd, entry.name, {
        catalogDir: opts.catalogDir,
        fetch: opts.fetch,
        resolveFiles: opts.resolveStackFiles,
      })
    } catch (error) {
      if (!(error instanceof ComposeReadError)) throw error
      composeUnread = true
      console.warn(
        `rostok: ${error.message}, so its image versions are not pinned. ` +
          `Run the same \`rostok stack add\` again to pin them.`,
      )
    }
  }
  /** Tag variables this run filled from a `+meta.ts` default, not from the user. */
  const defaultedKeys = new Set<string>()

  const writtenEntries: EnvEntry[] = []
  const skippedKeys: string[] = []
  let newCount = 0
  let keptCount = 0

  for (const spec of entry.meta.variables) {
    const normalized = normalizeVariableSpec(spec)
    const key = normalized.key
    const providedValue = opts.providedVars?.[key]
    const existingValue = existingByKey.get(key)

    // 1. --var always wins, even over an existing value. A --var that
    //    happens to match what's already there is "kept", not "new" —
    //    it's not adding a value, just confirming one.
    // #313: a new value with `$` is single-quoted (encodeEnvValue);
    // an existing one (step 2) is never re-encoded.
    if (providedValue !== undefined) {
      const encoded = encodeEnvValue(key, providedValue)
      writtenEntries.push({ key, value: encoded })
      if (encoded === existingValue) keptCount++
      else newCount++
      continue
    }

    // 2. Keep whatever is already in .env — never clobber another
    //    stack's key, never regenerate a secret on re-run. This also
    //    covers a stack-declared key that's also a server key (e.g.
    //    traefik's CONTACT_EMAIL): server create already wrote it, so
    //    it's "existing" by the time any stack add runs.
    if (existingValue !== undefined) {
      writtenEntries.push({ key, value: existingValue })
      keptCount++
      continue
    }

    // 3. Function/string default, or prompt/skip. Only reached when the
    //    key has no value anywhere yet, so `() => generatePassword()`
    //    only runs on first add.
    const resolved = ctx
      ? resolveVariable(normalized, undefined, ctx)
      : resolvedSkipContext(normalized, undefined)

    const decision = decidePrompt(normalized, resolved?.value)
    let value: string | undefined
    let fallback: string | undefined

    if (decision === "use-resolved" && resolved) {
      value = resolved.value
      defaultedKeys.add(key)
    } else if (decision === "prompt") {
      fallback = typeof normalized.default === "function" ? undefined : normalized.default
      // #212: every prompt carries its --var key in parentheses. A
      // stack's own `question` (when set) is the human label; with no
      // question, the key alone is the label, so it's never shown twice
      // as "KEY (KEY)".
      value = await promptValue({
        key,
        label: normalized.question ? withKeyLabel(normalized.question, key) : key,
        fallback,
        secret: normalized.secret,
        nonInteractive: !!opts.nonInteractive,
        promptFn: opts.promptFn,
      })
    } else {
      skippedKeys.push(key)
      continue
    }

    // #210 + review: an unresolved `${...}` left after default
    // resolution is an error naming the key — checked only for a value
    // this run just resolved from a default, not for whatever was
    // already sitting in .env (step 2 above never reaches here). #313:
    // never for a value a person typed either: it is written literally
    // (encodeEnvValue), and this error would print part of it.
    const fromDefault = value === resolved?.value || value === fallback
    const bad = fromDefault ? value.match(/\$\{[^}]*\}/) : null
    if (bad) {
      throw new UserError(`unresolved reference in ${key}: ${bad[0]}`)
    }

    writtenEntries.push({ key, value: encodeEnvValue(key, value) })
    newCount++
  }

  // #340 pin step. A tag variable the user set (already in .env, passed
  // with --var, or typed at a prompt) is theirs and stays. Every other
  // one gets the version the registry resolves; when the registry cannot
  // be asked, pinImages warns and the variable stays unset, so the
  // floating default this run would have written is dropped too and the
  // next `stack add` can still pin it.
  // #425: `latest` already in .env (left by a run under the `latest`
  // policy, say) is not a pin, so under `pinned` it is pinned like an
  // unset variable. A --var latest is the user's choice and stays.
  const floatingLatest = new Set(
    images.map(({ variable }) => variable).filter((variable) => {
      const value = existingByKey.get(variable)
      return value !== undefined && decodeEnvValue(value) === "latest"
    }),
  )
  const toPin = images.filter(({ variable }) =>
    opts.providedVars?.[variable] === undefined && (floatingLatest.has(variable) ||
      !existingByKey.has(variable) &&
        (defaultedKeys.has(variable) || !writtenEntries.some((e) => e.key === variable)))
  )
  if (composeUnread) {
    // Only the compose file says which variables are image tags. Without
    // it, the catalog's naming rule stands in: a default this run filled
    // for a variable named *_IMAGE_TAG is not written, so the variable
    // stays unset and the next `stack add` can pin it.
    for (const key of defaultedKeys) {
      const at = key.endsWith("_IMAGE_TAG") ? writtenEntries.findIndex((e) => e.key === key) : -1
      if (at === -1) continue
      writtenEntries.splice(at, 1)
      newCount--
    }
  }
  if (toPin.length > 0) {
    const pins = await pinImages(
      toPin,
      createRegistryClient({ fetch: opts.fetch }),
      (message) => console.warn(message),
      new Map([...floatingLatest].map((variable) => [variable, "latest"])),
    )
    for (const { variable } of toPin) {
      const at = writtenEntries.findIndex((e) => e.key === variable)
      const pin = pins.find((p) => p.key === variable)
      if (floatingLatest.has(variable)) {
        // Not pinned (pinImages warned): the existing `latest` stays.
        if (!pin) continue
        if (at !== -1) {
          writtenEntries.splice(at, 1)
          keptCount--
        }
        writtenEntries.push(pin)
        newCount++
        console.log(`rostok: ${variable} was latest, pinned to ${pin.value}.`)
        continue
      }
      if (at !== -1) {
        writtenEntries.splice(at, 1)
        newCount--
      }
      if (pin) {
        writtenEntries.push(pin)
        newCount++
      }
    }
  }

  // Write servers/<server>/.env. `existing` (read from disk again inside
  // writeEnvFilePreservingFormat) is the base so hand-edits to
  // non-declared keys AND any comments/blank lines survive (#236);
  // `writtenEntries` (existing values kept as-is, plus anything new) is
  // the incoming layer.
  await writeEnvFilePreservingFormat(envPath, writtenEntries)

  // Update servers/<server>/config.json with the stack list.
  await updateServerConfig(serverDir, entry)

  // Re-encrypt servers/<server>/.env → .env.age (non-fatal).
  await reencryptAfterWrite(cwd)

  const valueWord = newCount === 1 ? "value" : "values"
  console.log(
    `added ${stackName} to ${serverName}: ${newCount} new ${valueWord}, ${keptCount} kept`,
  )

  return {
    stackName,
    serverName,
    writtenEntries,
    skippedKeys,
    newCount,
    keptCount,
    declinedRequires,
  }
}

/**
 * Resolve a VariableSpec without a server context. Used by tests + the
 * rare case where the user invokes stack add before server-create.
 */
function resolvedSkipContext(
  spec: VariableSpec,
  providedValue: string | undefined,
) {
  if (providedValue !== undefined) return { value: providedValue, fromDefault: false }
  if (typeof spec.default === "function") {
    const v = spec.default()
    if (v !== undefined) return { value: v, fromDefault: true }
  }
  if (typeof spec.default === "string") return { value: spec.default, fromDefault: true }
  return null
}

export type ServerConfigFile = { stacks: { name: string }[] }

/** Read servers/<n>/config.json's stack list. Missing file → empty list. */
export async function readServerConfig(serverDir: string): Promise<ServerConfigFile> {
  const configPath = join(serverDir, "config.json")
  try {
    const text = await Deno.readTextFile(configPath)
    const cfg = JSON.parse(text)
    if (!Array.isArray(cfg.stacks)) cfg.stacks = []
    return cfg
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return { stacks: [] }
    throw err
  }
}

/** Read or create servers/<n>/config.json with the new stack entry. */
async function updateServerConfig(serverDir: string, entry: CatalogEntry): Promise<void> {
  const configPath = join(serverDir, "config.json")
  const cfg = await readServerConfig(serverDir)
  if (!cfg.stacks.some((s) => s.name === entry.meta.name)) {
    cfg.stacks.push({ name: entry.meta.name })
  }
  await Deno.writeTextFile(configPath, JSON.stringify(cfg, null, 2) + "\n")
}

/**
 * `entry.meta.requires` names not yet in `servers/<n>/config.json`'s
 * stack list (#212 point 1). Empty when the stack declares no
 * requirements or every one of them is already present.
 */
async function unmetRequires(serverDir: string, entry: CatalogEntry): Promise<string[]> {
  const required = entry.meta.requires ?? []
  if (required.length === 0) return []
  const cfg = await readServerConfig(serverDir)
  const present = new Set(cfg.stacks.map((s) => s.name))
  return required.filter((name) => !present.has(name))
}
