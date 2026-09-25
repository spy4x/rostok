// Tests for cli/commands/stack-remove.ts — the `rostok stack remove`
// wiring (next-steps message truthfulness in particular: since 1.2.0
// (#241) a full deploy stops the removed stack itself, then removes
// its directory and keeps its data — see cli/deploy/stale-stacks.ts —
// while a single-stack deploy never removes it at all, and the message
// must name the real PATH_APPS/VOLUMES_PATH-derived paths).

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

async function seedServer(
  dir: string,
  name: string,
  pathApps: string,
  volumesPath: string,
): Promise<void> {
  await Deno.mkdir(join(dir, "servers", name), { recursive: true })
  await Deno.writeTextFile(
    join(dir, "servers", name, ".env"),
    `DOMAIN=example.com\nPATH_APPS=${pathApps}\nVOLUMES_PATH=${volumesPath}\n`,
  )
}

Deno.test("runStackRemove: next steps name the stack's real directory and data path, and the single-stack deploy that keeps it", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeLibrespeedCatalog(catalogDir)
    await seedServer(dir, "home", "/srv/apps", "/srv/volumes")
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
    assertEquals(lines.includes("  rostok deploy home"), true, lines.join("\n"))
    // Exact line: the real PATH_APPS-derived stack directory, VOLUMES_PATH
    // named as a whole (not <VOLUMES_PATH>/<stack> — not every stack's data
    // lives in a folder named after the stack), and the single-stack
    // deploy command that does NOT remove the stack.
    assertEquals(
      lines.includes(
        "  (stops librespeed, removes /srv/apps/stacks/librespeed and keeps everything " +
          "under /srv/volumes; `rostok deploy home librespeed` does not remove it.)",
      ),
      true,
      lines.join("\n"),
    )
  })
})

Deno.test("runStackRemove: falls back to naming the missing env vars when PATH_APPS and VOLUMES_PATH aren't known", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeLibrespeedCatalog(catalogDir)
    await Deno.mkdir(join(dir, "servers", "home"), { recursive: true })
    await Deno.writeTextFile(join(dir, "servers", "home", ".env"), "DOMAIN=example.com\n")
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
    assertEquals(
      lines.includes(
        "  (stops librespeed, removes its directory and keeps its data — the exact paths " +
          "aren't shown because PATH_APPS and VOLUMES_PATH aren't set in home's .env; " +
          "`rostok deploy home librespeed` does not remove it.)",
      ),
      true,
      lines.join("\n"),
    )
  })
})

Deno.test("runStackRemove: falls back to naming VOLUMES_PATH alone when only it is missing", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeLibrespeedCatalog(catalogDir)
    await Deno.mkdir(join(dir, "servers", "home"), { recursive: true })
    await Deno.writeTextFile(
      join(dir, "servers", "home", ".env"),
      "DOMAIN=example.com\nPATH_APPS=/srv/apps\n",
    )
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
    assertEquals(
      lines.includes(
        "  (stops librespeed, removes its directory and keeps its data — the exact paths " +
          "aren't shown because VOLUMES_PATH isn't set in home's .env; " +
          "`rostok deploy home librespeed` does not remove it.)",
      ),
      true,
      lines.join("\n"),
    )
  })
})
