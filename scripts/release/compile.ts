/**
 * Builds the release binaries: one `deno compile` per target in {@link RELEASE_TARGETS}, with the
 * `stacks/` catalog embedded, each gzip-compressed to `rostok-<target>.gz`, plus a `SHA256SUMS`
 * file listing the `.gz` files in `sha256sum` format. `rostok upgrade` and `install.sh` verify a
 * download against that file.
 *
 * ```bash
 * deno task compile                                  # every target, into dist/
 * deno task compile --out /tmp/r --target x86_64-unknown-linux-gnu
 * ```
 *
 * Woodpecker runs it on a `v*` tag (step `binaries`); it holds no secret.
 *
 * @module
 */
import { fromFileUrl, join, resolve } from "@std/path"
import { assetName, RELEASE_TARGETS, sha256Hex } from "../../cli/upgrade.ts"

/** gzip in memory. */
async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Compiles, compresses and lists every target; returns the `SHA256SUMS` text. */
export async function compileAll(outDir: string, targets: readonly string[]): Promise<string> {
  const root = fromFileUrl(new URL("../..", import.meta.url))
  await Deno.mkdir(outDir, { recursive: true })
  const lines: string[] = []
  for (const target of targets) {
    const raw = join(outDir, `rostok-${target}`)
    console.log(`Compiling ${target}...`)
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["compile", "-A", "--include", "stacks", "--target", target, "-o", raw, "cli/+main.ts"],
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    }).output()
    if (!out.success) throw new Error(`deno compile failed for ${target} (exit ${out.code})`)
    const gz = await gzip(await Deno.readFile(raw))
    await Deno.remove(raw)
    const name = assetName(target)
    await Deno.writeFile(join(outDir, name), gz)
    // `sha256sum` format: hex, two spaces, file name.
    lines.push(`${await sha256Hex(gz)}  ${name}`)
  }
  const sums = lines.join("\n") + "\n"
  await Deno.writeTextFile(join(outDir, "SHA256SUMS"), sums)
  return sums
}

/**
 * Reads `--out <dir>` (default `dist`) and repeatable `--target <triple>` (default: every
 * release target). Throws on an unknown flag or target.
 */
export function parseCompileArgs(args: string[]): { out: string; targets: string[] } {
  let out = "dist"
  const targets: string[] = []
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1]
    if (args[i] === "--out" && value) out = value
    else if (args[i] === "--target" && value) targets.push(value)
    else throw new Error(`unknown or incomplete argument: ${args[i]}`)
    i++
  }
  for (const t of targets) {
    if (!(RELEASE_TARGETS as readonly string[]).includes(t)) {
      throw new Error(`unknown target ${t}; known: ${RELEASE_TARGETS.join(", ")}`)
    }
  }
  return { out, targets: targets.length > 0 ? targets : [...RELEASE_TARGETS] }
}

if (import.meta.main) {
  const { out, targets } = parseCompileArgs(Deno.args)
  console.log(await compileAll(resolve(out), targets))
}
