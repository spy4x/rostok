// Shell helpers — small wrappers around `new Deno.Command(...)` for the
// recurring "is this command on PATH?" check.
//
// Replaces three near-identical inline snippets that previously lived in
// init.ts (git), encrypt.ts (age), and server-create.ts (whoami).

const _pathCache = new Map<string, boolean>()

/**
 * Return `true` if `cmd` is on PATH. Probes by running `<cmd> --version`
 * with both stdout and stderr swallowed; exit 0 means the command
 * resolved. Results are cached per process — checks inside a single CLI
 * invocation are free.
 */
export async function isCommandOnPath(cmd: string): Promise<boolean> {
  const cached = _pathCache.get(cmd)
  if (cached !== undefined) return cached
  let ok = false
  try {
    const out = await new Deno.Command(cmd, {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output()
    ok = out.success
  } catch {
    ok = false
  }
  _pathCache.set(cmd, ok)
  return ok
}

/**
 * Run `cmd [...args]`, returning trimmed stdout. Returns `undefined` if
 * the command failed or isn't on PATH. Use for best-effort probes like
 * `whoami` where the caller has a fallback.
 */
export async function tryCaptureStdout(
  cmd: string,
  args: string[] = [],
): Promise<string | undefined> {
  try {
    const out = await new Deno.Command(cmd, {
      args,
      stdout: "piped",
      stderr: "null",
    }).output()
    if (!out.success) return undefined
    return new TextDecoder().decode(out.stdout).trim()
  } catch {
    return undefined
  }
}
