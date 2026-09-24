// Tests for cli/commands/stack-add.ts — the actual `rostok stack add`
// wiring, not just the pure buildNextSteps half (cli/next-steps.test.ts
// already covers that in isolation).
//
// Leftover from #227's review: nothing proved that a declined `requires`
// dependency (stackAdd's `declinedRequires`) actually reaches the real
// CLI's own next-steps output — `runStackAdd` is the seam that wires
// `stackAdd`'s result into `buildNextSteps`, and it's what the cliffy
// `.action()` calls, so testing it directly (with `confirmFn` injected)
// exercises the same code path as the real `rostok stack add` command.

import { assertEquals } from "@std/assert"
import { join } from "@std/path"
import { runStackAdd } from "./stack-add.ts"

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "rostok-commands-stack-add-" })
  try {
    return await fn(dir)
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {})
  }
}

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

async function seedServer(dir: string, name: string): Promise<void> {
  await Deno.mkdir(join(dir, "servers", name), { recursive: true })
  await Deno.writeTextFile(
    join(dir, "servers", name, ".env"),
    "PROJECT=hl\nDOMAIN=example.com\n",
  )
}

Deno.test("runStackAdd: declining a requires dependency prints its own `stack add` next step", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeTraefikWebCatalog(catalogDir)
    await seedServer(dir, "home")

    const lines: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => lines.push(args.join(" "))
    try {
      const result = await runStackAdd(
        "web",
        { server: "home", catalog: catalogDir, nonInteractive: false },
        dir,
        { confirmFn: () => Promise.resolve(false) }, // decline adding traefik
      )
      assertEquals(result.declinedRequires, ["traefik"])
      // The exact indented "Next steps:" line (buildNextSteps's own
      // format) — not just a substring, which stackAdd's own inline
      // "skipped adding 'traefik' ... run rostok stack add traefik -s
      // home" message would also satisfy without buildNextSteps ever
      // seeing `declinedRequires` at all.
      assertEquals(lines.includes("  rostok stack add traefik -s home"), true, lines.join("\n"))
    } finally {
      console.log = originalLog
    }
  })
})

Deno.test("runStackAdd: accepting a requires dependency does NOT suggest re-adding it", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeTraefikWebCatalog(catalogDir)
    await seedServer(dir, "home")

    const lines: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => lines.push(args.join(" "))
    try {
      const result = await runStackAdd(
        "web",
        { server: "home", catalog: catalogDir, nonInteractive: false },
        dir,
        { confirmFn: () => Promise.resolve(true) }, // accept adding traefik
      )
      assertEquals(result.declinedRequires, [])
      const output = lines.join("\n")
      assertEquals(output.includes("rostok stack add traefik -s home"), false, output)
      assertEquals(output.includes("rostok deploy home"), true, output)
    } finally {
      console.log = originalLog
    }
  })
})
