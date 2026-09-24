// Tests for cli/commands/stack-remove.ts — the `rostok stack remove`
// wiring (next-steps message truthfulness in particular: deploy deletes
// the stack's directory but doesn't stop its containers — see
// cli/deploy/run-deploy.ts's stale-stack cleanup, a `rm -rf`, not a
// `docker compose down` — and the message must name a real directory
// and a real command, never a `container-*` glob docker can't expand).

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

async function seedServer(dir: string, name: string, pathApps: string): Promise<void> {
  await Deno.mkdir(join(dir, "servers", name), { recursive: true })
  await Deno.writeTextFile(
    join(dir, "servers", name, ".env"),
    `DOMAIN=example.com\nPATH_APPS=${pathApps}\n`,
  )
}

Deno.test("runStackRemove: next steps name the stack's real directory and docker compose down, not a glob", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeLibrespeedCatalog(catalogDir)
    await seedServer(dir, "home", "/srv/apps")
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
    // Exact line: the real PATH_APPS-derived directory, a real command
    // (docker compose down there), no hl-<name>-* glob.
    assertEquals(
      lines.includes(
        "  (deletes /srv/apps/stacks/librespeed on the server, but does not stop its " +
          "containers — run `docker compose down` in /srv/apps/stacks/librespeed on the " +
          "server first, or stop them by hand afterward.)",
      ),
      true,
      lines.join("\n"),
    )
  })
})

Deno.test("runStackRemove: falls back to a generic notice when PATH_APPS isn't known", async () => {
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
        "  (deletes librespeed's directory on the server, but does not stop its containers " +
          "— run `docker compose down` in that stack's directory on the server first, or " +
          "stop them by hand afterward.)",
      ),
      true,
      lines.join("\n"),
    )
  })
})
