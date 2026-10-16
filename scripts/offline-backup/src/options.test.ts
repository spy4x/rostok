import { assertEquals, assertThrows } from "@std/assert"
import {
  choose,
  chooseDrive,
  confirmRestore,
  type Options,
  parseOptions,
  UsageError,
} from "./options.ts"
import { checkDeletedRepos } from "./sync.ts"

/** Replaces `prompt()` for one test and records every question asked. */
async function withPrompt<T>(
  reply: string | null,
  fn: (asked: string[]) => T | Promise<T>,
): Promise<T> {
  const original = globalThis.prompt
  const asked: string[] = []
  globalThis.prompt = (message?: string) => {
    asked.push(message ?? "")
    return reply
  }
  try {
    return await fn(asked)
  } finally {
    globalThis.prompt = original
  }
}

Deno.test("parseOptions reads every flag", () => {
  const options = parseOptions(
    [
      "--drive",
      "/dev/sda",
      "--verify",
      "FULL",
      "--smart=skip",
      "--use-mounted",
      "--delete-missing",
      "--overwrite-local",
    ],
    true,
  )
  assertEquals(options, {
    interactive: true,
    drive: "sda",
    verify: "full",
    smart: "skip",
    useMounted: true,
    deleteMissing: true,
    overwriteLocal: true,
  })
})

Deno.test("parseOptions turns prompts off with --yes or without a terminal", () => {
  assertEquals(parseOptions(["-y"], true).interactive, false)
  assertEquals(parseOptions(["--yes"], true).interactive, false)
  assertEquals(parseOptions([], false).interactive, false)
  assertEquals(parseOptions([], true).interactive, true)
})

Deno.test("parseOptions rejects unknown flags, stray words and bad values", () => {
  assertThrows(() => parseOptions(["--force"], true), UsageError, "--force")
  assertThrows(() => parseOptions(["sda"], true), UsageError, "sda")
  assertThrows(() => parseOptions(["--verify", "quick"], true), UsageError, "--verify")
  assertThrows(() => parseOptions(["--smart", "no"], true), UsageError, "--smart")
  assertThrows(() => parseOptions(["--drive", "../sda"], true), UsageError, "--drive")
  assertThrows(() => parseOptions(["--drive"], true), UsageError, "--drive")
  for (const flag of ["--delete-missing=no", "--overwrite-local=0", "--yes=FALSE"]) {
    assertThrows(() => parseOptions([flag], false), UsageError, flag.split("=")[0])
  }
  assertEquals(parseOptions(["--delete-missing=false"], false).deleteMissing, false)
})

const unattended: Options = parseOptions([], false)
const attended: Options = parseOptions([], true)

Deno.test("choose takes the flag, then the default without asking, then the reply", async () => {
  await withPrompt("long", (asked) => {
    assertEquals(choose(attended, "skip", "q", "short"), "skip")
    assertEquals(choose(unattended, undefined, "q", "short"), "short")
    assertEquals(asked, [])
    assertEquals(choose(attended, undefined, "q", "short"), "long")
    assertEquals(asked, ["q"])
  })
})

Deno.test("chooseDrive requires --drive when it may not ask", async () => {
  await withPrompt("sdb", (asked) => {
    assertThrows(() => chooseDrive(unattended), UsageError, "--drive")
    assertEquals(chooseDrive({ ...unattended, drive: "sda" }), "sda")
    assertEquals(chooseDrive(attended), "sdb")
    assertEquals(asked.length, 1)
  })
})

Deno.test("confirmRestore needs --overwrite-local or a typed RESTORE, never --yes alone", async () => {
  await withPrompt("RESTORE", (asked) => {
    assertEquals(confirmRestore(unattended), false)
    assertEquals(confirmRestore({ ...unattended, overwriteLocal: true }), true)
    assertEquals(asked, [])
    assertEquals(confirmRestore(attended), true)
  })
  await withPrompt("yes", () => assertEquals(confirmRestore(attended), false))
})

Deno.test("checkDeletedRepos keeps drive-only repositories unless --delete-missing", async () => {
  const root = await Deno.makeTempDir()
  try {
    await Deno.mkdir(`${root}/local/kept`, { recursive: true })
    await Deno.mkdir(`${root}/drive/target/kept`, { recursive: true })
    await Deno.mkdir(`${root}/drive/target/gone`, { recursive: true })
    const paths = [{ source: `${root}/local`, target: "target" }]
    const drive = `${root}/drive`

    await withPrompt("yes", async (asked) => {
      assertEquals(await checkDeletedRepos(paths, drive, unattended), false)
      assertEquals(
        await checkDeletedRepos(paths, drive, { ...unattended, deleteMissing: true }),
        true,
      )
      assertEquals(asked, [])
    })
    await withPrompt("no", async () => {
      assertEquals(await checkDeletedRepos(paths, drive, attended), false)
    })
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
