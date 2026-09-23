import { assert, assertEquals, assertThrows } from "@std/assert"
import { join } from "@std/path"
import {
  handleStagingSignal,
  installStagingSignalCleanup,
  STAGING_CLEANUP_SIGNALS,
} from "./run-deploy.ts"

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

Deno.test("handleStagingSignal: removes the staging dir before it returns control, then exits", async () => {
  // Regression for #219's staging race: an async handler yields to the
  // event loop between its steps, and the deploy's pending writes then
  // recreate the dir. The handler must finish its cleanup synchronously,
  // so the dir is gone by the time exit() is reached, with no await.
  const stagingDir = await Deno.makeTempDir({ prefix: "rostok-deploy-test-" })
  await Deno.mkdir(join(stagingDir, "stacks", "demo"), { recursive: true })
  await Deno.writeTextFile(join(stagingDir, ".env"), "SECRET=x")
  let dirGoneAtExit: boolean | undefined
  const exit = (code: number) => {
    try {
      Deno.statSync(stagingDir)
      dirGoneAtExit = false
    } catch (err) {
      dirGoneAtExit = err instanceof Deno.errors.NotFound
    }
    throw new ExitCalled(code)
  }
  const error = assertThrows(() => handleStagingSignal(stagingDir, 129, exit), ExitCalled)
  assertEquals(error.code, 129)
  assertEquals(dirGoneAtExit, true)
})

Deno.test("installStagingSignalCleanup: covers SIGHUP, SIGINT, SIGQUIT and SIGTERM and removes them again", () => {
  const added: string[] = []
  const removed: string[] = []
  const originalAdd = Deno.addSignalListener
  const originalRemove = Deno.removeSignalListener
  Deno.addSignalListener = (signal: Deno.Signal) => void added.push(signal)
  Deno.removeSignalListener = (signal: Deno.Signal) => void removed.push(signal)
  try {
    const uninstall = installStagingSignalCleanup("/nonexistent/rostok-deploy-x")
    assertEquals(added.sort(), ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"])
    uninstall()
    assertEquals(removed.sort(), added)
  } finally {
    Deno.addSignalListener = originalAdd
    Deno.removeSignalListener = originalRemove
  }
})

Deno.test("STAGING_CLEANUP_SIGNALS: exit codes follow the shell's 128 + signal number", () => {
  const codes = Object.fromEntries(STAGING_CLEANUP_SIGNALS.map((s) => [s.signal, s.code]))
  assertEquals(codes, { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 })
  assert(STAGING_CLEANUP_SIGNALS.length === 4)
})
