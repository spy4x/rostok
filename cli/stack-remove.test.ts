// Tests for cli/stack-remove.ts — #225.

import { assertEquals, assertExists, assertRejects, assertStringIncludes } from "@std/assert"
import { decodeBase64 } from "@std/encoding"
import { join } from "@std/path"
import { UserError } from "./errors.ts"
import { readEnvFile } from "./env-files.ts"
import { readServerConfig, stackAdd } from "./stack-add.ts"
import { stackRemove } from "./stack-remove.ts"
import { generateAgeKey } from "./encrypt.ts"
import { parseEnvFile } from "./age.ts"

/**
 * `cli/age.ts` resolves `.age/key.txt` via `git rev-parse
 * --git-common-dir` from the process cwd, honouring `GIT_DIR` (and
 * friends) if a caller's environment sets them — this repo's own
 * pre-commit hook runs `deno task check` from inside a worktree, where
 * git sets `GIT_DIR` itself, so a test that doesn't clear these could
 * silently read the OWNER'S real `.age/key.txt` instead of a temp one.
 * `withIsolatedGitEnv` saves and deletes them for `fn`'s duration
 * (restored after, even on failure), then `git init`s `dir` so
 * resolution has its own, deterministic repo to find — pointing at
 * `dir`'s own key, never anything outside it.
 */
async function withIsolatedGitEnv<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const GIT_ENV_KEYS = ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]
  const saved = new Map(GIT_ENV_KEYS.map((k) => [k, Deno.env.get(k)]))
  for (const k of GIT_ENV_KEYS) Deno.env.delete(k)
  try {
    const init = await new Deno.Command("git", {
      args: ["init", "-q"],
      cwd: dir,
      stdout: "null",
      stderr: "piped",
    }).output()
    if (!init.success) {
      throw new Error(`git init failed: ${new TextDecoder().decode(init.stderr)}`)
    }
    return await fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) Deno.env.delete(k)
      else Deno.env.set(k, v)
    }
  }
}

/** Decrypt an `age64:<base64>` value with an explicit key file — bypasses cli/age.ts's own (globally cached) key resolution entirely, so this proves exactly which key produced a ciphertext. */
async function decryptWithKeyFile(age64Value: string, keyFile: string): Promise<string> {
  const AGE64_PREFIX = "age64:"
  if (!age64Value.startsWith(AGE64_PREFIX)) {
    throw new Error(`not an age64 value: ${age64Value.slice(0, 20)}`)
  }
  const ciphertext = decodeBase64(age64Value.slice(AGE64_PREFIX.length))
  const cmd = new Deno.Command("age", {
    args: ["-d", "-i", keyFile, "-o", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  })
  const proc = cmd.spawn()
  const writer = proc.stdin.getWriter()
  await writer.write(ciphertext)
  await writer.close()
  const output = await proc.output()
  if (!output.success) {
    throw new Error(`age decrypt failed: ${new TextDecoder().decode(output.stderr)}`)
  }
  return new TextDecoder().decode(output.stdout).trim()
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "rostok-stack-remove-" })
  try {
    return await fn(dir)
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {})
  }
}

/** Fixture catalog: traefik (declares CONTACT_EMAIL, a server key) + web (requires traefik). */
async function writeTraefikWebCatalog(catalogDir: string): Promise<void> {
  await Deno.mkdir(join(catalogDir, "traefik"), { recursive: true })
  await Deno.writeTextFile(
    join(catalogDir, "traefik", "+meta.ts"),
    `import type { StackMeta } from "@rostok/cli"
export default {
  name: "traefik",
  description: "reverse proxy",
  variables: [
    { key: "TRAEFIK_IMAGE_TAG", default: "3.0", required: false },
    { key: "CONTACT_EMAIL", default: "a@example.com", required: true },
  ],
} satisfies StackMeta
`,
  )
  await Deno.mkdir(join(catalogDir, "web"), { recursive: true })
  await Deno.writeTextFile(
    join(catalogDir, "web", "+meta.ts"),
    `import type { StackMeta } from "@rostok/cli"
export default {
  name: "web",
  description: "a web stack",
  requires: ["traefik"],
  variables: [{ key: "WEB_DOMAIN", default: "web.\${DOMAIN}", required: true }],
} satisfies StackMeta
`,
  )
}

/** Fixture catalog: one stack, no requires, one of its own secret keys. */
async function writeLibrespeedCatalog(catalogDir: string): Promise<void> {
  await Deno.mkdir(join(catalogDir, "librespeed"), { recursive: true })
  await Deno.writeTextFile(
    join(catalogDir, "librespeed", "+meta.ts"),
    `import type { StackMeta } from "@rostok/cli"
export default {
  name: "librespeed",
  description: "speed test",
  variables: [
    { key: "LIBRESPEED_PASSWORD", default: "secret", required: true },
    { key: "LIBRESPEED_DOMAIN", default: "speed.\${DOMAIN}", required: true },
  ],
} satisfies StackMeta
`,
  )
}

async function seedServer(dir: string, name: string, env: Record<string, string>): Promise<void> {
  await Deno.mkdir(join(dir, "servers", name), { recursive: true })
  const text = Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n"
  await Deno.writeTextFile(join(dir, "servers", name, ".env"), text)
}

// ─────────────────────────────────────────────────────────────────────
// Missing server / missing stack.
// ─────────────────────────────────────────────────────────────────────

Deno.test("stack remove: missing server fails with a UserError", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeLibrespeedCatalog(catalogDir)
    const err = await assertRejects(
      () => stackRemove("librespeed", "ghost", { cwd: dir, catalogDir }),
      UserError,
    )
    // #236: exact text, not just "not found" — this is the same wording
    // `rostok deploy`/`cli/deploy/run-deploy.ts` use for the identical
    // case; the two used to read differently.
    const envPath = join(dir, "servers", "ghost", ".env")
    assertEquals(
      err.message,
      `server 'ghost' not found at ${envPath}. Run \`rostok server create ghost\` first.`,
    )
  })
})

Deno.test("stack remove: a stack not installed on the server fails with a UserError", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeLibrespeedCatalog(catalogDir)
    await seedServer(dir, "home", { DOMAIN: "example.com" })
    await Deno.writeTextFile(
      join(dir, "servers", "home", "config.json"),
      JSON.stringify({ stacks: [] }),
    )
    const err = await assertRejects(
      () => stackRemove("librespeed", "home", { cwd: dir, catalogDir }),
      UserError,
    )
    assertStringIncludes(err.message, "not installed on 'home'")
  })
})

// Review fix — tryFindStack must only swallow a genuine "not found in
// catalog", never an "ambiguous stack name" (findStack throws that when
// more than one entry's directory name or meta.name matches — a bug in
// the catalog, not "this stack no longer exists"). Silently treating an
// ambiguous match as "delisted" would run the catalog-orphan removal
// path against the WRONG entry's assumptions.
Deno.test("stack remove: an ambiguous catalog match propagates, not swallowed as 'not in catalog'", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    // Two directories whose meta.name both resolve to "dup" — findStack
    // matches on directory name OR meta.name, so looking up "dup" hits
    // both.
    for (const dirName of ["foo", "bar"]) {
      await Deno.mkdir(join(catalogDir, dirName), { recursive: true })
      await Deno.writeTextFile(
        join(catalogDir, dirName, "+meta.ts"),
        `import type { StackMeta } from "@rostok/cli"
export default {
  name: "dup",
  description: "fixture — deliberately ambiguous",
  variables: [],
} satisfies StackMeta
`,
      )
    }
    await seedServer(dir, "home", { DOMAIN: "example.com" })

    const err = await assertRejects(
      () => stackRemove("dup", "home", { cwd: dir, catalogDir }),
      UserError,
    )
    assertStringIncludes(err.message, "ambiguous")
  })
})

// ─────────────────────────────────────────────────────────────────────
// Config.json removal + own env keys (drop-env flag, confirm, notice).
// ─────────────────────────────────────────────────────────────────────

async function addLibrespeed(dir: string, catalogDir: string): Promise<void> {
  await stackAdd("librespeed", "home", { cwd: dir, catalogDir, nonInteractive: true })
}

Deno.test("stack remove --drop-env: removes from config.json and drops its own env keys, without asking", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeLibrespeedCatalog(catalogDir)
    await seedServer(dir, "home", { DOMAIN: "example.com" })
    await addLibrespeed(dir, catalogDir)

    const result = await stackRemove("librespeed", "home", {
      cwd: dir,
      catalogDir,
      dropEnv: true,
      confirmFn: () => {
        throw new Error("must not ask when --drop-env is set")
      },
    })
    assertEquals(result.droppedKeys.sort(), ["LIBRESPEED_DOMAIN", "LIBRESPEED_PASSWORD"])

    const cfg = await readServerConfig(join(dir, "servers", "home"))
    assertEquals(cfg.stacks.some((s) => s.name === "librespeed"), false)

    const entries = await readEnvFile(join(dir, "servers", "home", ".env"))
    assertEquals(entries.some((e) => e.key.startsWith("LIBRESPEED_")), false)
  })
})

Deno.test("stack remove -n (non-interactive, no --drop-env): removes from config.json, leaves env keys with a notice", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeLibrespeedCatalog(catalogDir)
    await seedServer(dir, "home", { DOMAIN: "example.com" })
    await addLibrespeed(dir, catalogDir)

    const lines: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => lines.push(args.join(" "))
    let result
    try {
      result = await stackRemove("librespeed", "home", {
        cwd: dir,
        catalogDir,
        nonInteractive: true,
      })
    } finally {
      console.log = originalLog
    }
    assertEquals(result.droppedKeys, [])
    assertEquals(result.keptOwnKeys.sort(), ["LIBRESPEED_DOMAIN", "LIBRESPEED_PASSWORD"])
    assertEquals(lines.some((l) => l.includes("--drop-env")), true, lines.join("\n"))

    const cfg = await readServerConfig(join(dir, "servers", "home"))
    assertEquals(cfg.stacks.some((s) => s.name === "librespeed"), false)

    const entries = await readEnvFile(join(dir, "servers", "home", ".env"))
    assertEquals(entries.some((e) => e.key === "LIBRESPEED_PASSWORD"), true)
  })
})

Deno.test("stack remove interactive: confirming drops env keys, declining leaves them", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeLibrespeedCatalog(catalogDir)
    await seedServer(dir, "home", { DOMAIN: "example.com" })
    await addLibrespeed(dir, catalogDir)

    const declined = await stackRemove("librespeed", "home", {
      cwd: dir,
      catalogDir,
      confirmFn: () => Promise.resolve(false),
    })
    assertEquals(declined.droppedKeys, [])
    let entries = await readEnvFile(join(dir, "servers", "home", ".env"))
    assertEquals(entries.some((e) => e.key === "LIBRESPEED_PASSWORD"), true)

    // Re-add (config.json entry was already dropped by the call above)
    // so a second removal has something to confirm against.
    await addLibrespeed(dir, catalogDir)
    const confirmed = await stackRemove("librespeed", "home", {
      cwd: dir,
      catalogDir,
      confirmFn: () => Promise.resolve(true),
    })
    assertEquals(confirmed.droppedKeys.sort(), ["LIBRESPEED_DOMAIN", "LIBRESPEED_PASSWORD"])
    entries = await readEnvFile(join(dir, "servers", "home", ".env"))
    assertEquals(entries.some((e) => e.key === "LIBRESPEED_PASSWORD"), false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// #225 — a shared server-level key survives removal, even when this
// stack's own +meta.ts declares it (traefik's CONTACT_EMAIL).
// ─────────────────────────────────────────────────────────────────────

Deno.test("stack remove: a shared server-level key (CONTACT_EMAIL) survives, even though the stack declares it", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeTraefikWebCatalog(catalogDir)
    await seedServer(dir, "home", { DOMAIN: "example.com", CONTACT_EMAIL: "ops@example.com" })
    await stackAdd("traefik", "home", { cwd: dir, catalogDir, nonInteractive: true })

    const result = await stackRemove("traefik", "home", { cwd: dir, catalogDir, dropEnv: true })
    // Only TRAEFIK_IMAGE_TAG is a genuine stack-owned key here —
    // CONTACT_EMAIL is a server key (isServerKey) even though traefik's
    // own +meta.ts also declares it.
    assertEquals(result.droppedKeys, ["TRAEFIK_IMAGE_TAG"])

    const entries = await readEnvFile(join(dir, "servers", "home", ".env"))
    const byKey = new Map(entries.map((e) => [e.key, e.value]))
    assertEquals(byKey.get("CONTACT_EMAIL"), "ops@example.com")
    assertEquals(byKey.get("DOMAIN"), "example.com")
  })
})

// ─────────────────────────────────────────────────────────────────────
// requires refusal (#225) — refuses removing a stack another installed
// stack still requires, unless --force.
// ─────────────────────────────────────────────────────────────────────

Deno.test("stack remove: refuses to remove a stack another installed stack requires", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeTraefikWebCatalog(catalogDir)
    await seedServer(dir, "home", { DOMAIN: "example.com", CONTACT_EMAIL: "ops@example.com" })
    await stackAdd("traefik", "home", { cwd: dir, catalogDir, nonInteractive: true })
    await stackAdd("web", "home", { cwd: dir, catalogDir, nonInteractive: true })

    const err = await assertRejects(
      () =>
        stackRemove("traefik", "home", {
          cwd: dir,
          catalogDir,
          // The refusal must fire before ever asking about env keys —
          // a confirmFn that throws proves it.
          confirmFn: () => {
            throw new Error("must not ask — the requires refusal should fire first")
          },
        }),
      UserError,
    )
    assertStringIncludes(err.message, "required by web")
    assertStringIncludes(err.message, "--force")

    // Nothing removed — config.json still lists both.
    const cfg = await readServerConfig(join(dir, "servers", "home"))
    assertEquals(cfg.stacks.map((s) => s.name).sort(), ["traefik", "web"])
  })
})

Deno.test("stack remove --force: removes a required stack anyway", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeTraefikWebCatalog(catalogDir)
    await seedServer(dir, "home", { DOMAIN: "example.com", CONTACT_EMAIL: "ops@example.com" })
    await stackAdd("traefik", "home", { cwd: dir, catalogDir, nonInteractive: true })
    await stackAdd("web", "home", { cwd: dir, catalogDir, nonInteractive: true })

    await stackRemove("traefik", "home", { cwd: dir, catalogDir, force: true, dropEnv: true })

    const cfg = await readServerConfig(join(dir, "servers", "home"))
    assertEquals(cfg.stacks.map((s) => s.name), ["web"])
  })
})

// ─────────────────────────────────────────────────────────────────────
// Review fix — ask before writing anything (config.json used to be
// written before the "drop env values too?" question). confirmFn now
// runs while config.json still lists the stack; both files change only
// after the answer is known.
// ─────────────────────────────────────────────────────────────────────

Deno.test("stack remove: config.json still lists the stack when the drop-env question is asked; both change only after answering", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeLibrespeedCatalog(catalogDir)
    await seedServer(dir, "home", { DOMAIN: "example.com" })
    await addLibrespeed(dir, catalogDir)

    let stackStillListedWhenAsked = false
    await stackRemove("librespeed", "home", {
      cwd: dir,
      catalogDir,
      confirmFn: async () => {
        const cfg = await readServerConfig(join(dir, "servers", "home"))
        stackStillListedWhenAsked = cfg.stacks.some((s) => s.name === "librespeed")
        return true
      },
    })
    assertEquals(stackStillListedWhenAsked, true)

    // After answering, both config.json and .env reflect the removal.
    const cfg = await readServerConfig(join(dir, "servers", "home"))
    assertEquals(cfg.stacks.some((s) => s.name === "librespeed"), false)
    const entries = await readEnvFile(join(dir, "servers", "home", ".env"))
    assertEquals(entries.some((e) => e.key === "LIBRESPEED_PASSWORD"), false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Review fix — a stack that's in config.json but no longer resolves in
// the catalog can still be removed: config.json entry dropped, env
// cleanup skipped (no +meta.ts to say which keys are its own).
// ─────────────────────────────────────────────────────────────────────

Deno.test("stack remove: a stack no longer in the catalog is removed from config.json, env cleanup skipped", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeLibrespeedCatalog(catalogDir)
    await seedServer(dir, "home", { DOMAIN: "example.com" })
    await addLibrespeed(dir, catalogDir)

    // Simulate the stack having been dropped from the catalog since it
    // was added — remove its +meta.ts, leaving the config.json entry
    // and its .env values in place.
    await Deno.remove(join(catalogDir, "librespeed"), { recursive: true })

    const result = await stackRemove("librespeed", "home", {
      cwd: dir,
      catalogDir,
      dropEnv: true, // must be ignored — there's no +meta.ts to resolve keys from
      confirmFn: () => {
        throw new Error("must not ask — there's nothing to ask about without +meta.ts")
      },
    })
    assertEquals(result.envCleanupSkipped, true)
    assertEquals(result.droppedKeys, [])

    const cfg = await readServerConfig(join(dir, "servers", "home"))
    assertEquals(cfg.stacks.some((s) => s.name === "librespeed"), false)

    // Its env values are untouched.
    const entries = await readEnvFile(join(dir, "servers", "home", ".env"))
    assertEquals(entries.some((e) => e.key === "LIBRESPEED_PASSWORD"), true)
  })
})

Deno.test("stack remove: a stack no longer in the catalog can still be blocked by a requires dependent", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeTraefikWebCatalog(catalogDir)
    await seedServer(dir, "home", { DOMAIN: "example.com", CONTACT_EMAIL: "ops@example.com" })
    await stackAdd("traefik", "home", { cwd: dir, catalogDir, nonInteractive: true })
    await stackAdd("web", "home", { cwd: dir, catalogDir, nonInteractive: true })

    // traefik drops out of the catalog, but web (still installed, still
    // resolvable) still requires it.
    await Deno.remove(join(catalogDir, "traefik"), { recursive: true })

    const err = await assertRejects(
      () => stackRemove("traefik", "home", { cwd: dir, catalogDir }),
      UserError,
    )
    assertStringIncludes(err.message, "required by web")

    const cfg = await readServerConfig(join(dir, "servers", "home"))
    assertEquals(cfg.stacks.map((s) => s.name).sort(), ["traefik", "web"])
  })
})

// ─────────────────────────────────────────────────────────────────────
// Review fix — prove the re-encryption actually happens: .env.age must
// no longer contain a dropped key's line, not just .env. Removing the
// stackRemove's encryptEnvFiles(cwd) call leaves the OLD ciphertext
// line (including the now-deleted key) sitting in .env.age forever.
// ─────────────────────────────────────────────────────────────────────

Deno.test("stack remove --drop-env: the dropped key's line is gone from .env.age too, not just .env", async () => {
  const originalCwd = Deno.cwd()
  await withTmpDir(async (dir) => {
    Deno.chdir(dir)
    try {
      await withIsolatedGitEnv(dir, async () => {
        const catalogDir = join(dir, "catalog")
        await writeLibrespeedCatalog(catalogDir)
        await seedServer(dir, "home", { DOMAIN: "example.com" })
        const keyResult = await generateAgeKey(dir)
        assertEquals(keyResult.ok, true, keyResult.error)

        // A decoy key elsewhere, standing in for the real key a leaked
        // GIT_DIR could have pointed at — proof this test's ciphertext
        // was produced with `dir`'s own key, not this one.
        const decoyDir = await Deno.makeTempDir({ prefix: "rostok-stack-remove-decoy-" })
        try {
          const decoyKey = await generateAgeKey(decoyDir)
          assertEquals(decoyKey.ok, true, decoyKey.error)

          await addLibrespeed(dir, catalogDir)
          const agePath = join(dir, "servers", "home", ".env.age")
          const beforeAge = parseEnvFile(await Deno.readTextFile(agePath))
          assertEquals(
            beforeAge.some((e) => e.key === "LIBRESPEED_PASSWORD"),
            true,
            "sanity: .env.age must hold the key before removal",
          )

          await stackRemove("librespeed", "home", { cwd: dir, catalogDir, dropEnv: true })

          const afterAge = parseEnvFile(await Deno.readTextFile(agePath))
          assertEquals(afterAge.some((e) => e.key === "LIBRESPEED_PASSWORD"), false)

          // Prove the ciphertext was produced with THE TEMP key: a
          // surviving value (DOMAIN — a server key, untouched by the
          // removal) decrypts correctly with it, and fails outright
          // with the decoy — if the fix regressed and the decoy
          // (standing in for a leaked real key) had been used instead,
          // this decrypt-with-temp-key assertion is what catches it.
          const surviving = afterAge.find((e) => e.key === "DOMAIN")
          assertExists(surviving?.encrypted, "DOMAIN must still be encrypted")
          const plaintext = await decryptWithKeyFile(surviving!.encrypted!, keyResult.path)
          assertEquals(plaintext, "example.com")
          await assertRejects(() => decryptWithKeyFile(surviving!.encrypted!, decoyKey.path))
        } finally {
          await Deno.remove(decoyDir, { recursive: true }).catch(() => {})
        }
      })
    } finally {
      Deno.chdir(originalCwd)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// Review fix — the otherDeclaredKeys guard (#210 double-check): a key
// two stacks both declare (shouldn't happen per #210, but checked
// anyway) must survive removing one of them while the other stays
// installed.
// ─────────────────────────────────────────────────────────────────────

async function writeSharedKeyCatalog(catalogDir: string): Promise<void> {
  for (const name of ["shared-a", "shared-b"]) {
    await Deno.mkdir(join(catalogDir, name), { recursive: true })
    await Deno.writeTextFile(
      join(catalogDir, name, "+meta.ts"),
      `import type { StackMeta } from "@rostok/cli"
export default {
  name: "${name}",
  description: "fixture — declares a key another fixture stack also declares",
  variables: [
    { key: "${name.toUpperCase().replace("-", "_")}_OWN", default: "x", required: false },
    { key: "SHARED_TOKEN", default: "shared-default", required: false },
  ],
} satisfies StackMeta
`,
    )
  }
}

Deno.test("stack remove: a key two installed stacks both declare survives removing one of them", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeSharedKeyCatalog(catalogDir)
    await seedServer(dir, "home", { DOMAIN: "example.com" })
    await stackAdd("shared-a", "home", { cwd: dir, catalogDir, nonInteractive: true })
    await stackAdd("shared-b", "home", {
      cwd: dir,
      catalogDir,
      nonInteractive: true,
      // shared-b's stackAdd sees SHARED_TOKEN already set by shared-a
      // and keeps it (#210) — nothing more to arrange here.
    })

    const result = await stackRemove("shared-a", "home", {
      cwd: dir,
      catalogDir,
      dropEnv: true,
    })
    // SHARED_A_OWN is genuinely shared-a's own key; SHARED_TOKEN must be
    // excluded because shared-b (still installed) also declares it.
    assertEquals(result.droppedKeys, ["SHARED_A_OWN"])

    const entries = await readEnvFile(join(dir, "servers", "home", ".env"))
    assertEquals(entries.some((e) => e.key === "SHARED_TOKEN"), true)
    assertEquals(entries.some((e) => e.key === "SHARED_B_OWN"), true)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Security review — an undeclared key that merely shares this stack's
// prefix (a hand-added `.env` line, or a value an earlier `stack
// remove -n` left behind) must never be treated as "this stack's own"
// just because it starts with the right prefix — only what `+meta.ts`
// actually declares is ever a removal candidate (module comment above).
// ─────────────────────────────────────────────────────────────────────

Deno.test("stack remove --drop-env: an undeclared key sharing the stack's prefix survives", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeLibrespeedCatalog(catalogDir)
    await seedServer(dir, "home", { DOMAIN: "example.com" })
    await addLibrespeed(dir, catalogDir)
    // Not declared by librespeed's +meta.ts (only LIBRESPEED_PASSWORD
    // and LIBRESPEED_DOMAIN are) — e.g. a hand-added line, or a key an
    // earlier stack version used and dropped.
    const envPath = join(dir, "servers", "home", ".env")
    await Deno.writeTextFile(envPath, (await Deno.readTextFile(envPath)) + "LIBRESPEED_EXTRA=x\n")

    const result = await stackRemove("librespeed", "home", { cwd: dir, catalogDir, dropEnv: true })
    assertEquals(result.droppedKeys.sort(), ["LIBRESPEED_DOMAIN", "LIBRESPEED_PASSWORD"])

    const entries = await readEnvFile(envPath)
    assertEquals(entries.some((e) => e.key === "LIBRESPEED_EXTRA"), true)
  })
})

// #236 — stack remove --drop-env used to rewrite .env through
// parseEnv/serializeEnv, dropping every comment/blank line even for keys
// that were never touched. A hand-annotated file must keep its
// unrelated comments; only the removed stack's own lines disappear.
Deno.test("stack remove --drop-env preserves hand-written comments and blank lines for untouched keys", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeLibrespeedCatalog(catalogDir)
    await seedServer(dir, "home", { DOMAIN: "example.com" })
    await addLibrespeed(dir, catalogDir)
    const envPath = join(dir, "servers", "home", ".env")
    const before = await Deno.readTextFile(envPath)
    await Deno.writeTextFile(
      envPath,
      `# server-level settings\n${before}\n# nothing after this\n`,
    )

    await stackRemove("librespeed", "home", { cwd: dir, catalogDir, dropEnv: true })

    const after = await Deno.readTextFile(envPath)
    assertStringIncludes(after, "# server-level settings")
    assertStringIncludes(after, "# nothing after this")
    assertEquals(after.includes("LIBRESPEED_PASSWORD"), false)
    assertEquals(after.includes("LIBRESPEED_DOMAIN"), false)
  })
})
