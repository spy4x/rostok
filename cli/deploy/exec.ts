// Small local-process helpers for cli/deploy/**.
//
// Deliberately independent from scripts/+lib.ts: this directory ships
// inside the published CLI package (see shipped-stacks.ts and
// deno.jsonc's `publish` block), and JSR never publishes `scripts/`, so
// nothing under cli/deploy/ may import from it.
//
// #219: every ssh call deploy makes gets `-o ConnectTimeout=10`, so a
// dead server or an unanswered host-key prompt fails in ~10s instead of
// hanging the deploy indefinitely. `-o BatchMode=yes` is added on top
// when stdin isn't a TTY (`Deno.stdin.isTerminal()`) — an interactive
// deploy can still answer a host-key prompt, but a CI run or a piped
// invocation fails fast instead of hanging on one.

import {
  parseSshAddress,
  rsyncDestination,
  rsyncSshOption,
  sshArgs,
  type SshCallOptions,
  type SshTarget,
} from "../server-keys.ts"
import { trackChild } from "./process-registry.ts"

/** `{ batchMode: true }` unless stdin is a TTY — shared by every ssh/rsync spawn below. */
function defaultSshCallOptions(): { batchMode: boolean } {
  let isTerminal = false
  try {
    isTerminal = Deno.stdin.isTerminal()
  } catch {
    // Deno.stdin.isTerminal() throws if stdin is already closed — treat
    // that the same as "not a TTY".
  }
  return { batchMode: !isTerminal }
}

export interface CommandResult {
  success: boolean
  /** The raw exit code — ssh's own connection-level failures (unreachable host, timeout, refused, DNS) always exit 255, distinct from a remote command's own nonzero exit. */
  code: number
  output: string
  error: string
}

/** Run a local command (argv form) and capture its output. Tracked so a SIGINT/SIGTERM handler can kill it (process-registry.ts). */
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
  const child = proc.spawn()
  trackChild(child)
  const out = await child.output()
  return {
    success: out.code === 0,
    code: out.code,
    output: new TextDecoder().decode(out.stdout),
    error: new TextDecoder().decode(out.stderr),
  }
}

/**
 * Run `argv` on the remote host over ssh (each element its own argv
 * slot). `sshAddress` is parsed with `parseSshAddress` (throws a
 * UserError for anything unsafe before ssh is ever spawned) and turned
 * into argv with `sshArgs`, which puts `-p <port>` when the address
 * carries one, the standard `-o` options (see the module comment
 * above), and `--` ahead of the target — a second, independent guard
 * against the target being read as an ssh option, even though
 * `parseSshAddress` already rejects a leading `-`.
 */
export async function runRemoteCommand(
  sshAddress: string,
  argv: string[],
): Promise<CommandResult> {
  const target = parseSshAddress(sshAddress)
  return await runCommand(["ssh", ...sshArgs(target, argv, defaultSshCallOptions())])
}

/** Run a shell script on the remote host over ssh, as a single command string. Same guards as runRemoteCommand. */
export async function runRemoteShell(
  sshAddress: string,
  script: string,
): Promise<CommandResult> {
  const target = parseSshAddress(sshAddress)
  return await runCommand(["ssh", ...sshArgs(target, [script], defaultSshCallOptions())])
}

/**
 * The argv `runRemoteSync` passes to `rsync` (everything after the
 * binary name itself), built as a PURE function so its shape — the
 * trailing slash on both `localDir` and the destination, `-e`'s exact
 * value, where `--` lands — is testable without ever spawning `rsync`
 * (real or fake): a test asserts on this return value directly. Only
 * `runRemoteSync` itself calls this in production.
 */
export function rsyncSyncArgs(
  target: SshTarget,
  localDir: string,
  remotePath: string,
  extraArgs: string[],
  opts: SshCallOptions,
): string[] {
  return [
    ...extraArgs,
    "-e",
    rsyncSshOption(target, opts),
    "--",
    `${localDir}/`,
    `${rsyncDestination(target, remotePath)}/`,
  ]
}

/**
 * Run `rsync` from `localDir` to `sshAddress:remotePath`, with the same
 * ssh options as runRemoteCommand/runRemoteShell (`-e "ssh ..."`, port
 * included) — the one ssh spawn deploy makes that rsync itself owns
 * (see run-deploy.ts for why `--` in front of it can't reuse the same
 * `ssh --` trick the direct spawns above use).
 */
export async function runRemoteSync(
  sshAddress: string,
  localDir: string,
  remotePath: string,
  extraArgs: string[] = [],
): Promise<CommandResult> {
  const target = parseSshAddress(sshAddress)
  return await runCommand([
    "rsync",
    ...rsyncSyncArgs(target, localDir, remotePath, extraArgs, defaultSshCallOptions()),
  ])
}

/** The argv `runRemoteSyncEntry` passes to `rsync` — see `rsyncSyncArgs`'s own comment; same pure-testability reason. */
export function rsyncEntrySyncArgs(
  target: SshTarget,
  localEntryDir: string,
  remoteParentPath: string,
  extraArgs: string[],
  opts: SshCallOptions,
): string[] {
  return [
    ...extraArgs,
    "-e",
    rsyncSshOption(target, opts),
    "--",
    localEntryDir,
    `${rsyncDestination(target, remoteParentPath)}/`,
  ]
}

/**
 * Run `rsync` the way `runRemoteSync` does, EXCEPT the source keeps
 * `localEntryDir`'s own name instead of being merged into the
 * destination's contents: no trailing slash on the source, so rsync
 * transfers it as ONE named entry into `remoteParentPath` (which DOES
 * get a trailing slash, "sync this entry into that directory").
 *
 * This is the only rsync shape that's safe when the destination entry
 * might be a SYMLINK (#233 review): a real directory source with a
 * trailing slash, synced onto a same-named destination that's also
 * given a trailing slash (`runRemoteSync`'s own shape), makes rsync
 * follow the symlink and sync INTO whatever it points at — reproduced
 * once, manually, against a real local rsync: it deleted a file inside
 * the symlink's target that the source didn't even ship.
 * Source-as-an-entry into its PARENT instead makes rsync replace a
 * symlinked destination entry with a real directory, leaving whatever
 * the symlink pointed at completely untouched (same manual check) —
 * used for run-deploy.ts's per-stack sync into `PATH_APPS/stacks/`,
 * since a stack's own directory name is exactly the kind of thing an
 * attacker (or a stale VOLUMES_PATH-into-PATH_APPS mistake) could turn
 * into a symlink. Automated coverage stops at the argv shape above
 * (`rsyncEntrySyncArgs`, exec.test.ts) — no test here spawns rsync
 * itself (real or fake), so the actual symlink-replacement behavior is
 * a manual VM step (see the PR body).
 */
export async function runRemoteSyncEntry(
  sshAddress: string,
  localEntryDir: string,
  remoteParentPath: string,
  extraArgs: string[] = [],
): Promise<CommandResult> {
  const target = parseSshAddress(sshAddress)
  return await runCommand([
    "rsync",
    ...rsyncEntrySyncArgs(
      target,
      localEntryDir,
      remoteParentPath,
      extraArgs,
      defaultSshCallOptions(),
    ),
  ])
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

/**
 * Remove ASCII control characters (except newline and tab) and C1
 * control characters (`\x80`-`\x9f`) from remote output before it
 * reaches the terminal. Several deploy-time messages embed folder
 * names, docker labels or `readlink -f` output the server itself
 * supplied, and anyone with access there can shape those into escape
 * sequences — including 8-bit C1 codes, which some terminals interpret
 * the same as a `\x1b`-prefixed escape sequence.
 */
export function stripControlChars(s: string): string {
  // deno-lint-ignore no-control-regex
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
}
