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
          "aren't shown because VOLUMES_PATH isn't set in home's .env or .env.root; " +
          "`rostok deploy home librespeed` does not remove it.)",
      ),
      true,
      lines.join("\n"),
    )
  })
})

/**
 * Add librespeed to `home` (whose `.env` is `serverEnv`, with `.env.root`
 * holding `rootEnv` when given), remove it, and return what
 * runStackRemove printed.
 */
async function removeAndCapture(serverEnv: string, rootEnv?: string): Promise<string[]> {
  return await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeLibrespeedCatalog(catalogDir)
    await Deno.mkdir(join(dir, "servers", "home"), { recursive: true })
    await Deno.writeTextFile(join(dir, "servers", "home", ".env"), serverEnv)
    if (rootEnv !== undefined) await Deno.writeTextFile(join(dir, ".env.root"), rootEnv)
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
    return lines
  })
}

function pathsLine(stackDir: string, volumesPath: string): string {
  return `  (stops librespeed, removes ${stackDir} and keeps everything under ${volumesPath}; ` +
    "`rostok deploy home librespeed` does not remove it.)"
}

Deno.test("runStackRemove: reads VOLUMES_PATH from .env.root when the server .env lacks it", async () => {
  const lines = await removeAndCapture(
    "DOMAIN=example.com\nPATH_APPS=/srv/apps\n",
    "VOLUMES_PATH=/srv/volumes\n",
  )
  assertEquals(
    lines.includes(pathsLine("/srv/apps/stacks/librespeed", "/srv/volumes")),
    true,
    lines.join("\n"),
  )
})

Deno.test("runStackRemove: the server .env wins over .env.root for the same key", async () => {
  const lines = await removeAndCapture(
    "DOMAIN=example.com\nVOLUMES_PATH=/data/server\n",
    "VOLUMES_PATH=/data/root\n",
  )
  assertEquals(
    lines.includes(pathsLine("/srv/apps/stacks/librespeed", "/data/server")),
    true,
    lines.join("\n"),
  )
})

Deno.test("runStackRemove: uses deploy's PATH_APPS default when PATH_APPS is unset", async () => {
  const lines = await removeAndCapture("DOMAIN=example.com\nVOLUMES_PATH=/srv/volumes\n")
  assertEquals(
    lines.includes(pathsLine("/srv/apps/stacks/librespeed", "/srv/volumes")),
    true,
    lines.join("\n"),
  )
})

Deno.test("runStackRemove: strips a trailing slash and expands ${VAR} references like deploy", async () => {
  const lines = await removeAndCapture(
    "DOMAIN=example.com\nPATH_APPS=/srv/apps/\nVOLUMES_PATH=${BASE_PATH}/volumes/\n",
    "BASE_PATH=/data\n",
  )
  assertEquals(
    lines.includes(pathsLine("/srv/apps/stacks/librespeed", "/data/volumes")),
    true,
    lines.join("\n"),
  )
})

Deno.test("runStackRemove: a reference deploy refuses to expand is named, not printed", async () => {
  // expandEnvRefs only expands path-shaped keys (PATH_* or *_PATH); a
  // reference to DOMAIN makes deploy itself refuse VOLUMES_PATH.
  const lines = await removeAndCapture(
    "DOMAIN=example.com\nPATH_APPS=/srv/apps\nVOLUMES_PATH=/srv/${DOMAIN}\n",
  )
  assertEquals(
    lines.some((l) =>
      l.includes(
        "because VOLUMES_PATH is invalid in home's .env or .env.root, so deploy would refuse it;",
      )
    ),
    true,
    lines.join("\n"),
  )
  assertEquals(lines.some((l) => l.includes("example.com")), false, lines.join("\n"))
})

Deno.test("runStackRemove: names both keys, in the plural, when deploy would refuse both", async () => {
  // PATH_APPS needs two path components; VOLUMES_PATH must be absolute.
  const lines = await removeAndCapture(
    "DOMAIN=example.com\nPATH_APPS=/srv\nVOLUMES_PATH=relative/volumes\n",
  )
  assertEquals(
    lines.includes(
      "  (stops librespeed, removes its directory and keeps its data — the exact paths " +
        "aren't shown because PATH_APPS and VOLUMES_PATH are invalid in home's .env or " +
        ".env.root, so deploy would refuse them; `rostok deploy home librespeed` does not " +
        "remove it.)",
    ),
    true,
    lines.join("\n"),
  )
  assertEquals(lines.some((l) => l.includes("relative/volumes")), false, lines.join("\n"))
})

Deno.test("runStackRemove: expands VOLUMES_PATH against the already-expanded PATH_APPS", async () => {
  // PATH_APPS itself references BASE_PATH: expanding VOLUMES_PATH against
  // the raw PATH_APPS would leave "${BASE_PATH}" in it.
  const lines = await removeAndCapture(
    "DOMAIN=example.com\nPATH_APPS=${BASE_PATH}/apps\nVOLUMES_PATH=${PATH_APPS}-volumes\n",
    "BASE_PATH=/data\n",
  )
  assertEquals(
    lines.includes(pathsLine("/data/apps/stacks/librespeed", "/data/apps-volumes")),
    true,
    lines.join("\n"),
  )
})

Deno.test("runStackRemove: expands VOLUMES_PATH before PATH_APPS loses its trailing slash, like deploy", async () => {
  // Deploy expands ${PATH_APPS}volumes to /data/apps/volumes (nested
  // inside PATH_APPS, refused); normalising PATH_APPS first would give
  // the sibling /data/appsvolumes and print a path deploy never uses.
  const lines = await removeAndCapture(
    "DOMAIN=example.com\nPATH_APPS=/data/apps/\nVOLUMES_PATH=${PATH_APPS}volumes\n",
  )
  assertEquals(
    lines.some((l) =>
      l.includes("because PATH_APPS and VOLUMES_PATH are invalid in home's .env or .env.root")
    ),
    true,
    lines.join("\n"),
  )
  assertEquals(lines.some((l) => l.includes("appsvolumes")), false, lines.join("\n"))
})
