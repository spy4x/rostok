// Everything `rostok offline` touches outside its own logic — processes,
// the terminal, prompts, the clock — behind one object, so tests run the
// whole flow with fakes: no real disk, no sudo, no TTY.

import { join } from "@std/path"
import {
  type ConfirmFn,
  defaultConfirmFn,
  defaultPromptFn,
  defaultSelectFn,
  type PromptFn,
  type SelectFn,
} from "../prompts.ts"

/** What a finished process returned. */
export interface CommandResult {
  success: boolean
  output: string
  error: string
}

export interface RunOptions {
  /** Run through `sudo -n`: fails at once instead of asking for a password. */
  sudo?: boolean
  /** Extra environment variables for this process only. */
  env?: Record<string, string>
}

/** Starts processes. The real one is {@link denoRunner}. */
export interface Runner {
  run(cmd: string[], opts?: RunOptions): Promise<CommandResult>
  /** Like `run`, but hands each stdout chunk to `onChunk` while the process runs. */
  stream(cmd: string[], onChunk: (text: string) => void): Promise<CommandResult>
  /** `sudo -v` with the terminal attached, so sudo may ask for the password once. */
  sudoLogin(): Promise<boolean>
}

/** The outside world, as `rostok offline` sees it. */
export interface OfflineDeps {
  /** The project root: `.env.root` is read from here. */
  cwd: string
  home: string
  /** Numeric user id, or null where the platform has none. */
  uid: number | null
  /** `Deno.build.os`. */
  os: string
  runner: Runner
  /** True when `cmd` is an executable file on PATH. */
  hasCommand(cmd: string): Promise<boolean>
  /** True when stdin is a terminal. */
  isTerminal(): boolean
  promptFn: PromptFn
  confirmFn: ConfirmFn
  selectFn: SelectFn
  print(line: string): void
  printError(line: string): void
  now(): number
  sleep(ms: number): Promise<void>
}

const decoder = new TextDecoder()

/** Runs real processes with `Deno.Command`. A missing binary is a failed result, not a throw. */
export const denoRunner: Runner = {
  async run(cmd, opts = {}) {
    const argv = opts.sudo ? ["sudo", "-n", ...cmd] : cmd
    try {
      const out = await new Deno.Command(argv[0], {
        args: argv.slice(1),
        env: opts.env,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output()
      return {
        success: out.success,
        output: decoder.decode(out.stdout),
        error: decoder.decode(out.stderr),
      }
    } catch (error) {
      return { success: false, output: "", error: String(error) }
    }
  },
  async stream(cmd, onChunk) {
    let child: Deno.ChildProcess
    try {
      child = new Deno.Command(cmd[0], {
        args: cmd.slice(1),
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).spawn()
    } catch (error) {
      return { success: false, output: "", error: String(error) }
    }
    // Read stderr while stdout streams: a full stderr pipe would stall the process.
    const stderr = new Response(child.stderr).text()
    const streamDecoder = new TextDecoder()
    for await (const chunk of child.stdout) {
      onChunk(streamDecoder.decode(chunk, { stream: true }))
    }
    const status = await child.status
    return { success: status.success, output: "", error: await stderr }
  },
  async sudoLogin() {
    try {
      const out = await new Deno.Command("sudo", {
        args: ["-v"],
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }).output()
      return out.success
    } catch {
      return false
    }
  },
}

/** True when `cmd` is an executable file in one of the `PATH` folders. */
export async function findOnPath(cmd: string, path: string): Promise<boolean> {
  for (const dir of path.split(":")) {
    if (!dir) continue
    try {
      const info = await Deno.stat(join(dir, cmd))
      if (info.isFile && ((info.mode ?? 0o111) & 0o111) !== 0) return true
    } catch {
      // not in this folder
    }
  }
  return false
}

/** The real outside world for a command run from `cwd`. */
export function defaultDeps(cwd: string): OfflineDeps {
  return {
    cwd,
    home: Deno.env.get("HOME") ?? "",
    uid: Deno.uid(),
    os: Deno.build.os,
    runner: denoRunner,
    hasCommand: (cmd) => findOnPath(cmd, Deno.env.get("PATH") ?? ""),
    isTerminal: () => Deno.stdin.isTerminal(),
    promptFn: defaultPromptFn,
    confirmFn: defaultConfirmFn,
    selectFn: defaultSelectFn,
    print: (line) => console.log(line),
    printError: (line) => console.error(line),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

/**
 * Prints progress and keeps every printed line with its time, so a run
 * can save the same text as a log file on the drive.
 */
export class Reporter {
  readonly #deps: OfflineDeps
  readonly #lines: string[] = []

  constructor(deps: OfflineDeps) {
    this.#deps = deps
  }

  /** Prints a line to stdout and records it. */
  line(text = ""): void {
    this.#deps.print(text)
    this.#record(text)
  }

  /** Prints a warning to stderr and records it. */
  warn(text: string): void {
    this.#deps.printError(text)
    this.#record(`WARN: ${text}`)
  }

  /** Every recorded line, each prefixed with its ISO time. */
  log(): string {
    return this.#lines.join("\n") + "\n"
  }

  /**
   * Runs one step: prints its name, then the name again with how long it
   * took. A step that throws prints nothing more; the error says why.
   */
  async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = this.#deps.now()
    this.line(`→ ${name}`)
    const result = await fn()
    this.line(`✓ ${name} (${formatDuration(this.#deps.now() - start)})`)
    return result
  }

  #record(text: string): void {
    const stamp = new Date(this.#deps.now()).toISOString()
    for (const part of text.split("\n")) this.#lines.push(`[${stamp}] ${part}`)
  }
}

/** `65_000` → `"1m 05s"`, `4_000` → `"4s"`. */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (n: number) => String(n).padStart(2, "0")
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`
  return `${seconds}s`
}
