// Tests for cli/wizard.ts — #209: non-interactive stack-step messaging
// and the optional repeatable --stack flag.

import { assertEquals, assertRejects } from "@std/assert"
import { join } from "@std/path"
import { runWizard } from "./wizard.ts"
import { UserError } from "./errors.ts"

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

// Review fix #5 — a --var reaching a stack added via --stack, not just
// the stack getting added with its defaults. Removing the providedVars
// pass-through in wizard.ts's --stack branch would leave this red.
Deno.test("runWizard: --var reaches a stack added via --stack", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await Deno.mkdir(join(catalogDir, "demo"), { recursive: true })
    await Deno.writeTextFile(
      join(catalogDir, "demo", "+meta.ts"),
      `import type { StackMeta } from "@rostok/cli"
export default {
  name: "demo",
  description: "fixture",
  variables: [{ key: "DEMO_TOKEN", question: "Token?", required: true }],
} satisfies StackMeta
`,
    )
    const result = await runWizard({
      cwd: dir,
      catalogDir,
      nonInteractive: true,
      serverInputs: SERVER_INPUTS,
      providedVars: { DEMO_TOKEN: "from-var" },
      stacks: ["demo"],
    })
    assertEquals(
      result.stackAdds[0].writtenEntries.find((e) => e.key === "DEMO_TOKEN")?.value,
      "from-var",
    )
  })
})

// Review fix #7 — a traversal name known up front leaves the folder
// empty: init must not run before the name is validated.
Deno.test("runWizard: -n --var serverName=../x leaves an empty folder", async () => {
  await withTmpDir(async (dir) => {
    await assertRejects(
      () =>
        runWizard({
          cwd: dir,
          nonInteractive: true,
          providedVars: { serverName: "../x" },
        }),
      UserError,
      "invalid server name",
    )
    const entries: string[] = []
    for await (const e of Deno.readDir(dir)) entries.push(e.name)
    assertEquals(entries, [], "init must not have written anything")
  })
})
