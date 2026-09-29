// Console and process helpers for `after.deploy.ts`.
//
// Copies of the helpers in `scripts/+lib.ts`: a hook runs from its jsr.io URL and cannot import
// from outside its own stack folder.

export function success(...args: unknown[]) {
  console.log(`%c${new Date().toISOString()} ${args.join(" ")}`, "color: green; font-weight: bold")
}

export function error(...args: unknown[]) {
  console.error(`%c${new Date().toISOString()} ${args.join(" ")}`, "color: red; font-weight: bold")
}

export function log(...args: unknown[]) {
  console.log(`${new Date().toISOString()}`, ...args)
}

/** Runs a command with stdin closed and returns its exit status and output. */
export async function runCommand(
  cmd: string[],
): Promise<{ success: boolean; output: string; error: string }> {
  const output = await new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output()
  return {
    success: output.code === 0,
    output: new TextDecoder().decode(output.stdout),
    error: new TextDecoder().decode(output.stderr),
  }
}
