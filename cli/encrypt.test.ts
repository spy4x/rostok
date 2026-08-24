// Tests for cli/encrypt.ts — age detection, best-effort skip, ageStatus.
//
// Tests assume `age` is installed (CI/dev box has it). We exercise:
//   - checkAgeInstalled returns true (caches after first call)
//   - ageStatus reports key presence correctly
//   - ageStatus finds env files in the project layout
//   - encryptEnvFiles + decryptEnvFiles skip with "no-key" when
//     .age/key.txt is missing (no-age path is unreachable here; the
//     no-key branch is the one that fires on a fresh machine that has
//     age but no keypair yet)
// The encryption logic itself lives in scripts/encryption/ and has
// its own tests (scripts/encryption/encryption.test.ts).

import { assertEquals, assertExists } from "@std/assert"
import { join } from "@std/path"
import { ageStatus, checkAgeInstalled, encryptEnvFiles, generateAgeKey } from "./encrypt.ts"

Deno.test("checkAgeInstalled: returns true on this machine (age is on PATH)", async () => {
  // The test runner has age installed (CI/dev box). If this fails, the
  // machine doesn't have age — install it before running the tests.
  assertEquals(await checkAgeInstalled(), true)
})

Deno.test("ageStatus: detects missing .age/key.txt", async () => {
  // Empty tmp dir: no key, no env files, no age files.
  const tmp = await Deno.makeTempDir({ prefix: "rostok-age-" })
  try {
    const status = await ageStatus(tmp)
    assertEquals(status.ageKeyPresent, false)
    assertEquals(status.envFiles.length, 0)
    assertEquals(status.ageFiles.length, 0)
    assertEquals(status.ageInstalled, true) // PATH check — independent of cwd
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("ageStatus: finds .env + servers/<n>/.env", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "rostok-age-" })
  try {
    await Deno.writeTextFile(join(tmp, ".env"), "A=1\n")
    await Deno.mkdir(join(tmp, "servers", "home"), { recursive: true })
    await Deno.writeTextFile(join(tmp, "servers", "home", ".env"), "B=2\n")
    // Should NOT be picked up: in node_modules, hidden, or .example.
    await Deno.mkdir(join(tmp, "node_modules"), { recursive: true })
    await Deno.writeTextFile(join(tmp, "node_modules", ".env"), "LEAK=9\n")
    await Deno.writeTextFile(join(tmp, ".env.example"), "C=3\n")

    const status = await ageStatus(tmp)
    assertEquals(
      status.envFiles.sort(),
      [
        join(tmp, ".env"),
        join(tmp, "servers", "home", ".env"),
      ].sort(),
    )
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("ageStatus: detects .age/key.txt when present", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "rostok-age-" })
  try {
    await Deno.mkdir(join(tmp, ".age"))
    await Deno.writeTextFile(join(tmp, ".age", "key.txt"), "placeholder")
    const status = await ageStatus(tmp)
    assertEquals(status.ageKeyPresent, true)
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("encryptEnvFiles: returns ok:false + skipped:'no-key' without .age/key.txt", async () => {
  // age is installed on PATH but no key file → encryption can't run.
  // Best-effort: warn with the keygen hint, return without throwing.
  // (The no-age branch is the same shape — covered by the no-key path
  //  since both return ok:false + a `skipped` reason without shelling out.)
  const tmp = await Deno.makeTempDir({ prefix: "rostok-encrypt-" })
  try {
    const result = await encryptEnvFiles(tmp)
    assertEquals(result.ok, false)
    assertEquals(result.skipped, "no-key")
    assertEquals(result.output, "")
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("decryptEnvFiles: same skip semantics as encrypt — no-key path returns ok:false", async () => {
  // Symmetric to encryptEnvFiles: the wrapper bails early without
  // shelling out when .age/key.txt is missing.
  const tmp = await Deno.makeTempDir({ prefix: "rostok-decrypt-" })
  try {
    const { decryptEnvFiles } = await import("./encrypt.ts")
    const result = await decryptEnvFiles(tmp)
    assertEquals(result.ok, false)
    assertEquals(result.skipped, "no-key")
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("generateAgeKey: writes .age/key.txt and returns public key", async () => {
  // Exercises the same code path that init's "would you like me to
  // generate the key?" prompt takes. age-keygen must be on PATH.
  const tmp = await Deno.makeTempDir({ prefix: "rostok-keygen-" })
  try {
    const result = await generateAgeKey(tmp)
    assertEquals(result.ok, true)
    assertExists(result.publicKey, "public key parsed from key file")
    assertEquals(result.publicKey?.startsWith("age1"), true)
    // The key file exists with the expected marker line.
    const content = await Deno.readTextFile(result.path)
    assertExists(content.match(/# public key: /))
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})
