// Small local-process helpers for cli/deploy/**.
//
// Deliberately independent from scripts/+lib.ts: this directory ships
// inside the published CLI package (see shipped-stacks.ts and
// deno.jsonc's `publish` block), and JSR never publishes `scripts/`, so
// nothing under cli/deploy/ may import from it.

export interface CommandResult {
  success: boolean
  output: string
  error: string
}

/** Run a local command (argv form) and capture its output. */
export async function runCommand(
  cmd: string[],
  opts?: { cwd?: string },
): Promise<CommandResult> {
  const proc = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: opts?.cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  })
  const out = await proc.output()
  return {
    success: out.code === 0,
    output: new TextDecoder().decode(out.stdout),
    error: new TextDecoder().decode(out.stderr),
  }
}

/** Run `argv` on the remote host over ssh (each element its own argv slot). */
export async function runRemoteCommand(
  sshAddress: string,
  argv: string[],
): Promise<CommandResult> {
  return await runCommand(["ssh", sshAddress, ...argv])
}

/** Run a shell script on the remote host over ssh, as a single command string. */
export async function runRemoteShell(
  sshAddress: string,
  script: string,
): Promise<CommandResult> {
  return await runCommand(["ssh", sshAddress, script])
}

/**
 * Single-quote `value` for embedding in a remote shell command string.
 * Every remote command rostok builds is one shell string (docker
 * compose, mkdir/chown loops, case patterns), so any value that comes
 * from `.env`, `config.json` or a stack name has to be quoted this way
 * — double quotes still let `$(...)`/backticks/`$VAR` run inside them,
 * and break outright on an embedded `"`. Single quotes suppress all of
 * that; the one thing they can't contain literally is `'` itself, which
 * is escaped as close-quote, escaped-quote, reopen-quote (`'\''`).
 */
export function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
