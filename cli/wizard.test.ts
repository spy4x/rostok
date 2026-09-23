// Tests for cli/wizard.ts — #209: non-interactive stack-step messaging
// and the optional repeatable --stack flag.

import { assertEquals } from "@std/assert"
import { join } from "@std/path"
import { runWizard } from "./wizard.ts"

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "rostok-wizard-" })
  try {
    return await fn(dir)
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {})
  }
}

const SERVER_INPUTS = {
  serverName: "home",
  sshTarget: "homelab",
  user: "deploy",
  domain: "example.test",
  contactEmail: "ops@example.test",
  project: "hl",
  dockerGroupId: "990",
  timezone: "UTC",
  puid: "1000",
  pgid: "1000",
  volumesPath: "/srv/volumes",
  pathApps: "/srv/apps",
}

Deno.test("runWizard: -n without --stack prints the skip message and adds nothing", async () => {
  await withTmpDir(async (dir) => {
    const lines: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => lines.push(args.join(" "))
    try {
      const result = await runWizard({
        cwd: dir,
        nonInteractive: true,
        serverInputs: SERVER_INPUTS,
      })
      assertEquals(result.stackAdds, [])
      assertEquals(
        lines.some((l) =>
          l.includes("skipped the stack step: run rostok stack add <name> -s home")
        ),
        true,
        lines.join("\n"),
      )
    } finally {
      console.log = originalLog
    }
  })
})

Deno.test("runWizard: -n with --stack adds each named stack from a fixture catalog", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await Deno.mkdir(join(catalogDir, "demo"), { recursive: true })
    await Deno.writeTextFile(
      join(catalogDir, "demo", "+meta.ts"),
      `import type { StackMeta } from "@rostok/cli"
export default {
  name: "demo",
  description: "fixture",
  variables: [{ key: "DEMO_DOMAIN", default: "demo.\${DOMAIN}", required: true }],
} satisfies StackMeta
`,
    )
    const result = await runWizard({
      cwd: dir,
      catalogDir,
      nonInteractive: true,
      serverInputs: SERVER_INPUTS,
      stacks: ["demo"],
    })
    assertEquals(result.stackAdds.length, 1)
    assertEquals(result.stackAdds[0].stackName, "demo")
  })
})
