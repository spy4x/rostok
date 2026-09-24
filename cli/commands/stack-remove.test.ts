// Tests for cli/commands/stack-remove.ts — the `rostok stack remove`
// wiring (next-steps message truthfulness in particular: deploy deletes
// the stack's directory but doesn't stop its containers — see
// cli/deploy/run-deploy.ts's stale-stack cleanup, a `rm -rf`, not a
// `docker compose down`).

import { assertEquals } from "@std/assert"
import { join } from "@std/path"
import { stackAdd } from "../stack-add.ts"
import { runStackRemove } from "./stack-remove.ts"

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "rostok-commands-stack-remove-" })
  try {
    return await fn(dir)
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {})
  }
}

async function writeLibrespeedCatalog(catalogDir: string): Promise<void> {
  await Deno.mkdir(join(catalogDir, "librespeed"), { recursive: true })
  await Deno.writeTextFile(
    join(catalogDir, "librespeed", "+meta.ts"),
    `import type { StackMeta } from "@rostok/cli"
export default {
  name: "librespeed",
  description: "speed test",
  variables: [{ key: "LIBRESPEED_PASSWORD", default: "secret", required: true }],
} satisfies StackMeta
`,
  )
}

async function seedServer(dir: string, name: string): Promise<void> {
  await Deno.mkdir(join(dir, "servers", name), { recursive: true })
  await Deno.writeTextFile(join(dir, "servers", name, ".env"), "DOMAIN=example.com\n")
}

Deno.test("runStackRemove: next steps say deploy, and that it does not stop the stack's containers", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeLibrespeedCatalog(catalogDir)
    await seedServer(dir, "home")
    await stackAdd("librespeed", "home", { cwd: dir, catalogDir, nonInteractive: true })

    const lines: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => lines.push(args.join(" "))
    try {
      await runStackRemove(
        "librespeed",
        { server: "home", catalog: catalogDir, dropEnv: true },
        dir,
      )
    } finally {
      console.log = originalLog
    }
    const output = lines.join("\n")
    assertEquals(output.includes("rostok deploy home"), true, output)
    assertEquals(output.includes("does not stop its"), true, output)
    assertEquals(output.includes("hl-librespeed"), true, output)
  })
})
