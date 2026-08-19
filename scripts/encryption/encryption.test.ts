import { assertEquals } from "@std/assert"
import { findEnvFiles, getRelativePath } from "./age-lib.ts"
import { indexOldAge, renderAgeContent } from "./encrypt.ts"

Deno.test({
  name: "getRelativePath removes cwd prefix from paths",
  fn() {
    // Uses Deno.cwd() internally, so test that a file outside cwd is unchanged
    const cwd = Deno.cwd()
    const testPath = `${cwd}/some/file.txt`
    const result = getRelativePath(testPath)
    // Should strip cwd prefix
    assertEquals(result, "some/file.txt")
  },
})

// Stand-ins for age: ciphertext is non-deterministic in reality, so make the
// fake encrypt return a different value each call. Any value that gets
// re-encrypted when it should have been reused therefore shows up as a diff.
function fakeCrypto() {
  let n = 0
  return {
    encrypt: (v: string) => Promise.resolve(`age64:${++n}:${btoa(v)}`),
    decrypt: (v: string) => Promise.resolve(atob(v.split(":")[2] ?? "")),
  }
}

/** Re-run renderAgeContent over its own output, the way env:decrypt/encrypt do. */
async function reencrypt(envContent: string, ageContent: string) {
  const { encrypt, decrypt } = fakeCrypto()
  const old = await indexOldAge(ageContent, decrypt)
  return await renderAgeContent(envContent, old, encrypt)
}

Deno.test({
  name: "renderAgeContent reuses ciphertext for unchanged values (zero diff noise)",
  async fn() {
    const { encrypt, decrypt } = fakeCrypto()
    const env = "A=one\nB=two\n"
    const first = await renderAgeContent(env, new Map(), encrypt)
    // Second pass over identical .env must reproduce the first byte for byte
    const second = await renderAgeContent(env, await indexOldAge(first, decrypt), encrypt)
    assertEquals(second, first)
  },
})

Deno.test({
  name: "renderAgeContent re-encrypts only the value that actually changed",
  async fn() {
    const { encrypt, decrypt } = fakeCrypto()
    const first = await renderAgeContent("A=one\nB=two\n", new Map(), encrypt)
    const old = await indexOldAge(first, decrypt)
    const second = await renderAgeContent("A=one\nB=CHANGED\n", old, encrypt)

    const line = (s: string, k: string) => s.split("\n").find((l) => l.startsWith(`${k}=`))
    assertEquals(line(second, "A"), line(first, "A")) // untouched
    assertEquals(line(second, "B") === line(first, "B"), false) // re-encrypted
  },
})

Deno.test({
  name: "renderAgeContent handles duplicate keys per occurrence, not per key",
  async fn() {
    // Regression: a key → value dict kept only the last value, so the first
    // occurrence compared unequal and was re-encrypted on every single run.
    const env = "NTFY_URL=first\nOTHER=x\nNTFY_URL=second\n"
    const { encrypt, decrypt } = fakeCrypto()
    const first = await renderAgeContent(env, new Map(), encrypt)
    const second = await renderAgeContent(env, await indexOldAge(first, decrypt), encrypt)
    assertEquals(second, first)

    // Both occurrences must survive, and decrypt back to their own values
    const occ = await indexOldAge(first, decrypt)
    assertEquals(occ.get("NTFY_URL")?.map((o) => o.plain), ["first", "second"])
  },
})

Deno.test({
  name: "renderAgeContent keeps exactly one trailing newline across runs",
  async fn() {
    // Regression: join("\n") + "\n" appended a blank line every run, so
    // .env.age accumulated trailing newlines indefinitely.
    let age = await reencrypt("A=one\n", "")
    assertEquals(age.endsWith("\n"), true)
    assertEquals(age.endsWith("\n\n"), false)

    for (let i = 0; i < 5; i++) {
      const env = age.split("\n").map((l) => l.startsWith("A=") ? "A=one" : l).join("\n")
      age = await reencrypt(env, age)
      assertEquals(age.endsWith("\n\n"), false, `grew a blank line on run ${i + 1}`)
    }
  },
})

Deno.test({
  name: "renderAgeContent preserves comments and drops keys removed from .env",
  async fn() {
    const { encrypt, decrypt } = fakeCrypto()
    const first = await renderAgeContent("# header\nA=one\n\nB=two\n", new Map(), encrypt)
    assertEquals(first.startsWith("# header\n"), true)

    // B removed from .env → must not be resurrected from the old .env.age
    const second = await renderAgeContent(
      "# header\nA=one\n",
      await indexOldAge(first, decrypt),
      encrypt,
    )
    assertEquals(second.includes("B="), false)
  },
})

Deno.test({
  name: "findEnvFiles does not descend into nested git checkouts",
  async fn() {
    // Regression: `git worktree add` targets inside the repo were walked, so
    // env:encrypt rewrote other branches' secrets with this checkout's values.
    const tmp = await Deno.makeTempDir()
    const cwd = Deno.cwd()
    try {
      await Deno.writeTextFile(`${tmp}/.env`, "A=1\n")

      await Deno.mkdir(`${tmp}/servers/home`, { recursive: true })
      await Deno.writeTextFile(`${tmp}/servers/home/.env`, "B=2\n")

      // A linked worktree: .git is a *file* pointing at the parent's gitdir
      await Deno.mkdir(`${tmp}/feat/some-branch`, { recursive: true })
      await Deno.writeTextFile(`${tmp}/feat/some-branch/.git`, "gitdir: /elsewhere\n")
      await Deno.writeTextFile(`${tmp}/feat/some-branch/.env`, "LEAK=3\n")

      // A nested clone: .git is a directory
      await Deno.mkdir(`${tmp}/vendor/dep/.git`, { recursive: true })
      await Deno.writeTextFile(`${tmp}/vendor/dep/.env`, "LEAK=4\n")

      Deno.chdir(tmp)
      const found = (await findEnvFiles()).map((p) => p.replace(`${Deno.cwd()}/`, ""))
      assertEquals(found.sort(), [".env", "servers/home/.env"])
    } finally {
      Deno.chdir(cwd)
      await Deno.remove(tmp, { recursive: true })
    }
  },
})

Deno.test({
  name: "renderAgeContent never reuses a plaintext line from .env.age",
  async fn() {
    // A .env.age line that is not age64 ciphertext must be encrypted, not
    // echoed back. Reusing it would leave the secret in cleartext forever,
    // because the value compares equal on every subsequent run.
    const leaked = "A=hunter2\n"
    const first = await reencrypt("A=hunter2\n", leaked)
    assertEquals(first.includes("hunter2"), false, "plaintext survived into .env.age")
    assertEquals(first.startsWith("A=age64:"), true)

    // And it stays encrypted once healed, without churning on later runs.
    const second = await reencrypt("A=hunter2\n", first)
    assertEquals(second, first, "healed value should be stable across runs")
  },
})
