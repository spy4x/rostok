// Resolves the files a stack needs to deploy (#203 point 2).
//
// `<project>/stacks/<name>/` wins if it exists — that keeps the owner's
// non-catalog stacks and forks working. Otherwise the files shipped
// inside the installed CLI package are used, resolved from
// `import.meta.url` via the checked-in manifest in shipped-stacks.ts.
//
// This has to work both for a local install (`deno install -g -A --root
// <tmp> -n rostok ./cli/+main.ts`, file:// URLs) and a JSR install
// (https:// URLs, which can't be directory-listed) — hence resolving
// every file explicitly from the manifest instead of walking a
// directory.

import { join, toFileUrl } from "@std/path"
import { exists } from "@std/fs"
import { UserError } from "../errors.ts"
import { SHIPPED_STACK_FILES } from "./shipped-stacks.ts"

export interface ResolvedStackFiles {
  /** Relative path inside `stacks/<name>/` → source URL (file:// or https://). */
  files: Map<string, string>
  origin: "local" | "shipped"
}

/**
 * Resolve `stackName`'s deploy files. Throws UserError if there's no
 * local override and the stack isn't part of the bundled catalog.
 */
export async function resolveStackFiles(
  projectDir: string,
  stackName: string,
): Promise<ResolvedStackFiles> {
  const localDir = join(projectDir, "stacks", stackName)
  if (await exists(localDir, { isDirectory: true })) {
    const files = new Map<string, string>()
    await collectLocalFiles(localDir, "", files)
    return { files, origin: "local" }
  }

  const manifest = SHIPPED_STACK_FILES[stackName]
  if (!manifest) {
    const bundled = Object.keys(SHIPPED_STACK_FILES).sort().join(", ")
    throw new UserError(
      `stack '${stackName}' has no ${localDir} and isn't part of the bundled catalog ` +
        `(bundled: ${bundled || "(none)"}).`,
    )
  }
  const files = new Map<string, string>()
  for (const rel of manifest) {
    files.set(rel, import.meta.resolve(`../../stacks/${stackName}/${rel}`))
  }
  return { files, origin: "shipped" }
}

async function collectLocalFiles(
  dir: string,
  prefix: string,
  out: Map<string, string>,
): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    const abs = join(dir, entry.name)
    if (entry.isDirectory) {
      await collectLocalFiles(abs, rel, out)
    } else if (entry.isFile) {
      out.set(rel, toFileUrl(abs).href)
    }
  }
}
