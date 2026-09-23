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

// #212 point 4 — a first-timer isn't limited to one stack per wizard
// run: --stack (the non-interactive equivalent of the multi-select
// Checkbox) accepts several names in one go.
Deno.test("runWizard: -n with multiple --stack adds every named stack in order", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    for (const name of ["demo", "demo2"]) {
      await Deno.mkdir(join(catalogDir, name), { recursive: true })
      await Deno.writeTextFile(
        join(catalogDir, name, "+meta.ts"),
        `import type { StackMeta } from "@rostok/cli"
export default {
  name: "${name}",
  description: "fixture",
  variables: [{ key: "${name.toUpperCase()}_DOMAIN", default: "${name}.\${DOMAIN}", required: true }],
} satisfies StackMeta
`,
      )
    }
    const result = await runWizard({
      cwd: dir,
      catalogDir,
      nonInteractive: true,
      serverInputs: SERVER_INPUTS,
      stacks: ["demo", "demo2"],
    })
    assertEquals(result.stackAdds.map((r) => r.stackName), ["demo", "demo2"])
  })
})

// #212 — the wizard ends with what was written and what to run next
// (deploy command + DNS records), not just "wizard complete." — when at
// least one stack was actually added.
Deno.test("runWizard: with a stack added, prints Next steps with the deploy command and DNS records", async () => {
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
    const lines: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => lines.push(args.join(" "))
    try {
      await runWizard({
        cwd: dir,
        catalogDir,
        nonInteractive: true,
        serverInputs: SERVER_INPUTS,
        stacks: ["demo"],
      })
    } finally {
      console.log = originalLog
    }
    const output = lines.join("\n")
    assertEquals(output.includes("Next steps:"), true, output)
    assertEquals(output.includes("rostok deploy home"), true, output)
    assertEquals(output.includes("DNS records:"), true, output)
    assertEquals(output.includes("A example.test"), true, output)
  })
})

// Review fix — with no stack picked (or named via --stack), config.json
// never gets a stack entry, so suggesting `rostok deploy` would suggest
// deploying nothing. The wizard should point at `stack add` instead.
Deno.test("runWizard: with no stacks picked, suggests `stack add` instead of `deploy`", async () => {
  await withTmpDir(async (dir) => {
    const lines: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => lines.push(args.join(" "))
    try {
      await runWizard({ cwd: dir, nonInteractive: true, serverInputs: SERVER_INPUTS })
    } finally {
      console.log = originalLog
    }
    const output = lines.join("\n")
    assertEquals(output.includes("rostok stack add <name> -s home"), true, output)
    assertEquals(output.includes("rostok deploy home"), false, output)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Review fix — the interactive branch (multi-select, key-generation
// offer) previously ran real cliffy prompts that no test could drive
// without a TTY, so several behaviors "stayed green when broken": a
// deleted Checkbox call, a deleted key-gen offer call, or a broken
// requires-within-selection resolution would all pass every existing
// test. `pickStacksFn`/`offerKeyGeneration`/`confirmFn` injection fixes
// that.
// ─────────────────────────────────────────────────────────────────────

/** Fixture catalog: traefik (no requires) + web (requires traefik). */
async function writeTraefikWebCatalog(catalogDir: string): Promise<void> {
  await Deno.mkdir(join(catalogDir, "traefik"), { recursive: true })
  await Deno.writeTextFile(
    join(catalogDir, "traefik", "+meta.ts"),
    `import type { StackMeta } from "@rostok/cli"
export default {
  name: "traefik",
  description: "reverse proxy",
  variables: [{ key: "TRAEFIK_IMAGE_TAG", default: "3.0", required: false }],
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

Deno.test("runWizard: multi-select — picking two stacks adds both", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeTraefikWebCatalog(catalogDir)
    const result = await runWizard({
      cwd: dir,
      catalogDir,
      serverInputs: SERVER_INPUTS,
      pickStacksFn: () => Promise.resolve(["traefik", "web"]),
    })
    assertEquals(result.stackAdds.map((r) => r.stackName).sort(), ["traefik", "web"])
  })
})

// #212 nit — the picker shows each stack's own description next to its
// name, so picking isn't blind.
Deno.test("runWizard: the stack picker's options show each stack's description next to its name", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeTraefikWebCatalog(catalogDir)
    let seenOptions: { name: string; value: string }[] = []
    await runWizard({
      cwd: dir,
      catalogDir,
      serverInputs: SERVER_INPUTS,
      pickStacksFn: (options) => {
        seenOptions = options
        return Promise.resolve([])
      },
    })
    const traefikOption = seenOptions.find((o) => o.value === "traefik")
    assertEquals(traefikOption?.name, "traefik — reverse proxy")
  })
})

// #212 nit — resolving requires against the WHOLE selection means
// picking traefik and web together never asks "add traefik?": traefik
// is reordered ahead of web (orderStacksByRequires) so it's already on
// the server by the time web's own requires check runs. A confirmFn
// that throws proves no such prompt happens.
Deno.test("runWizard: multi-select — picking traefik + web together never asks to add traefik (resolved against the whole selection)", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeTraefikWebCatalog(catalogDir)
    const result = await runWizard({
      cwd: dir,
      catalogDir,
      serverInputs: SERVER_INPUTS,
      pickStacksFn: () => Promise.resolve(["web", "traefik"]), // picked in dependent-first order
      confirmFn: () => {
        throw new Error("should never be asked — traefik was in the same selection")
      },
    })
    assertEquals(result.stackAdds.map((r) => r.stackName), ["traefik", "web"])
    assertEquals(result.stackAdds.every((r) => r.declinedRequires.length === 0), true)
  })
})

Deno.test("runWizard: the key-generation offer runs, once, after a fresh init, in interactive mode", async () => {
  await withTmpDir(async (dir) => {
    let calls = 0
    await runWizard({
      cwd: dir,
      serverInputs: SERVER_INPUTS,
      skipStackAdd: true,
      offerKeyGeneration: () => {
        calls++
        return Promise.resolve()
      },
    })
    assertEquals(calls, 1)
  })
})

Deno.test("runWizard: the key-generation offer does NOT run in non-interactive mode", async () => {
  await withTmpDir(async (dir) => {
    let calls = 0
    await runWizard({
      cwd: dir,
      nonInteractive: true,
      serverInputs: SERVER_INPUTS,
      skipStackAdd: true,
      offerKeyGeneration: () => {
        calls++
        return Promise.resolve()
      },
    })
    assertEquals(calls, 0)
  })
})

Deno.test("runWizard: the key-generation offer does NOT re-run on an already-initialized project", async () => {
  await withTmpDir(async (dir) => {
    // First run initializes the project (shouldOfferKeyGeneration: true).
    await runWizard({ cwd: dir, serverInputs: SERVER_INPUTS, skipStackAdd: true })
    let calls = 0
    await runWizard({
      cwd: dir,
      serverInputs: SERVER_INPUTS,
      skipStackAdd: true,
      offerKeyGeneration: () => {
        calls++
        return Promise.resolve()
      },
    })
    assertEquals(calls, 0)
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
