import { assert, assertRejects, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"
import { UserError } from "../errors.ts"
import { cleanup, type Fake, makeFake } from "./fake-deps.test.ts"
import { runVerify, type VerifyOptions } from "./verify-mode.ts"

const UNATTENDED: VerifyOptions = {
  drive: "sdb",
  nonInteractive: true,
  check: "fast",
  smart: "skip",
  eject: true,
}

/** Puts `restic-repos/` on the drive, with a repository `app` when `withRepo`. */
async function driveCopy(fake: Fake, withRepo: boolean): Promise<void> {
  const app = join(fake.mountDir, "restic-repos", "app")
  await Deno.mkdir(app, { recursive: true })
  if (withRepo) await Deno.writeTextFile(join(app, "config"), "")
}

Deno.test("verify: -n checks the copy on the drive, says it passed and ejects", async () => {
  const fake = await makeFake()
  try {
    await driveCopy(fake, true)
    await runVerify(fake.deps, UNATTENDED)
    assert(
      fake.calls.some((c) => c.startsWith("restic -r") && c.includes(" check")),
      fake.calls.join("\n"),
    )
    assertStringIncludes(fake.stdout.join("\n"), "Verification completed successfully")
    assert(fake.calls.some((c) => c.startsWith("udisksctl power-off")))
  } finally {
    await cleanup(fake)
  }
})

Deno.test("verify: a failed repository check exits 1 after the summary and the eject", async () => {
  const fake = await makeFake({ failing: ["restic"] })
  try {
    await driveCopy(fake, true)
    await assertRejects(() => runVerify(fake.deps, UNATTENDED), UserError, "verification failed")
    const out = fake.stdout.join("\n")
    assertStringIncludes(out, "Verification FAILED")
    assert(!out.includes("completed successfully"), out)
    assert(fake.calls.some((c) => c.startsWith("udisksctl power-off")))
  } finally {
    await cleanup(fake)
  }
})

Deno.test("verify: a drive folder with no repository to check exits 1 and never claims success", async () => {
  const fake = await makeFake()
  try {
    await driveCopy(fake, false)
    await assertRejects(() => runVerify(fake.deps, UNATTENDED), UserError, "verification failed")
    const out = fake.stdout.join("\n")
    assertStringIncludes(out, "Verification NOT VERIFIED")
    assert(!out.includes("completed successfully"), out)
  } finally {
    await cleanup(fake)
  }
})
