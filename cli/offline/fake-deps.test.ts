// A fake outside world for `rostok offline` tests: a project folder with
// .env.root, local backup sources, a folder standing in for the mounted
// drive, and a runner that answers lsblk, udisksctl, rsync, restic and
// the rest without starting a process. No real disk, sudo or terminal.
// No tests live here; the other tests in this folder import it.

import { copy } from "@std/fs"
import { join } from "@std/path"
import type { CommandResult, OfflineDeps, RunOptions } from "./context.ts"

export interface FakeDevice {
  name: string
  type?: string
  size?: string
  model?: string
  label?: string
  mountpoints?: string[]
  children?: FakeDevice[]
}

export interface FakeOptions {
  /**
   * What lsblk reports; a function is called on every lsblk run with the
   * run's number and the fake's mount folder.
   */
  devices?: FakeDevice[] | ((call: number, mountDir: string) => FakeDevice[])
  terminal?: boolean
  os?: string
  /** Tools reported as installed; default all. */
  tools?: string[]
  /** `sudo -n true` succeeds. Default true. */
  passwordlessSudo?: boolean
  /** Answers to text prompts, in order. */
  prompts?: string[]
  /** Answers to yes/no questions, in order. */
  confirms?: boolean[]
  /** Answer of the disk picker. */
  select?: string
  /** Commands (joined by spaces, starting with these words) that fail. */
  failing?: string[]
}

export interface Fake {
  deps: OfflineDeps
  /** Every command run, joined by spaces; sudo ones start with `sudo `. */
  calls: string[]
  stdout: string[]
  stderr: string[]
  /** Messages of every prompt, confirm and select, in order. */
  asked: string[]
  /** The picker's options, when it was shown. */
  selectOptions: { name: string; value: string; disabled?: boolean }[]
  root: string
  home: string
  /** Where udisksctl "mounts" the backup partition. */
  mountDir: string
}

/** A disk `sdb` with an OfflineBackups partition `sdb1`, plus the system disk. */
export function backupDrive(partition: Partial<FakeDevice> = {}): FakeDevice[] {
  return [
    systemDisk(),
    {
      name: "sdb",
      type: "disk",
      size: "1.8T",
      model: "Backup Plus",
      children: [{ name: "sdb1", type: "part", label: "OfflineBackups", ...partition }],
    },
  ]
}

/** The disk the machine runs from. */
export function systemDisk(): FakeDevice {
  return {
    name: "nvme0n1",
    type: "disk",
    size: "1T",
    model: "System SSD",
    children: [
      { name: "nvme0n1p1", type: "part", mountpoints: ["/boot/efi"] },
      { name: "nvme0n1p2", type: "part", mountpoints: ["/"] },
    ],
  }
}

/** A blank disk `sdc` with no partitions. */
export function blankDisk(): FakeDevice {
  return { name: "sdc", type: "disk", size: "2T", model: "New Drive", children: [] }
}

const ok = (output = ""): CommandResult => ({ success: true, output, error: "" })

/**
 * Builds the fake world in a fresh temp folder: `.env.root` with one
 * backup path (`~/backups` → `restic-repos`), a local repository
 * `~/backups/app` and an empty drive folder. Pass `env` to replace
 * `.env.root`, or null to leave it out.
 */
export async function makeFake(
  opts: FakeOptions = {},
  env: string | null = `BACKUP_PATHS=[{"source":"~/backups","target":"restic-repos"}]\n` +
    `BACKUPS_PASSWORD=secret\n`,
): Promise<Fake> {
  const root = await Deno.makeTempDir({ prefix: "rostok-offline-" })
  const project = join(root, "project")
  const home = join(root, "home")
  const mountDir = join(root, "media", "OfflineBackups")
  await Deno.mkdir(project, { recursive: true })
  await Deno.mkdir(join(home, "backups", "app"), { recursive: true })
  await Deno.writeTextFile(join(home, "backups", "app", "config"), "")
  await Deno.mkdir(mountDir, { recursive: true })
  if (env !== null) await Deno.writeTextFile(join(project, ".env.root"), env)

  const calls: string[] = []
  const stdout: string[] = []
  const stderr: string[] = []
  const asked: string[] = []
  const selectOptions: Fake["selectOptions"] = []
  const prompts = [...(opts.prompts ?? [])]
  const confirms = [...(opts.confirms ?? [])]
  const devices = opts.devices ?? backupDrive()
  let lsblkCalls = 0
  let now = Date.UTC(2026, 9, 16, 9, 0, 0)

  const run = (cmd: string[], runOpts: RunOptions = {}): CommandResult => {
    const line = `${runOpts.sudo ? "sudo " : ""}${cmd.join(" ")}`
    calls.push(line)
    if (opts.failing?.some((f) => cmd.join(" ").startsWith(f))) {
      return { success: false, output: "", error: `${cmd[0]}: failed` }
    }
    if (cmd[0] === "true" && runOpts.sudo) {
      return opts.passwordlessSudo === false
        ? { success: false, output: "", error: "sudo: a password is required" }
        : ok()
    }
    switch (cmd[0]) {
      case "lsblk": {
        const list = typeof devices === "function" ? devices(lsblkCalls++, mountDir) : devices
        return ok(JSON.stringify({ blockdevices: list }))
      }
      case "udisksctl":
        if (cmd[1] === "mount") return ok(`Mounted ${cmd[3]} at ${mountDir}`)
        return ok()
      case "du":
        return ok(`2048\t${cmd[2]}`)
      case "df":
        return ok(`     1B-blocks         Avail\n2000000000000 1000000000000\n`)
      default:
        return ok()
    }
  }

  const deps: OfflineDeps = {
    cwd: project,
    home,
    // The temp folder's owner is this process's user; Deno.uid() would need --allow-sys.
    uid: (await Deno.stat(root)).uid,
    os: opts.os ?? "linux",
    runner: {
      run: (cmd, runOpts) => Promise.resolve(run(cmd, runOpts)),
      // rsync really copies (without --delete), so later checks see the files.
      stream: async (cmd) => {
        const result = run(cmd)
        if (result.success && cmd[0] === "rsync") {
          await copy(cmd[cmd.length - 2], cmd[cmd.length - 1], { overwrite: true })
        }
        return result
      },
      sudoLogin: () => {
        calls.push("sudo -v")
        return Promise.resolve(false)
      },
    },
    hasCommand: (cmd) => Promise.resolve(opts.tools ? opts.tools.includes(cmd) : true),
    isTerminal: () => opts.terminal ?? false,
    promptFn: (base) => {
      asked.push(base.message)
      const answer = prompts.shift()
      if (answer === undefined) throw new Error(`unexpected prompt: ${base.message}`)
      return Promise.resolve(answer)
    },
    confirmFn: (o) => {
      asked.push(o.message)
      const answer = confirms.shift()
      if (answer === undefined) throw new Error(`unexpected confirm: ${o.message}`)
      return Promise.resolve(answer)
    },
    selectFn: (o) => {
      asked.push(o.message)
      selectOptions.push(...o.options)
      if (opts.select === undefined) throw new Error(`unexpected select: ${o.message}`)
      return Promise.resolve(opts.select)
    },
    print: (line) => stdout.push(line),
    printError: (line) => stderr.push(line),
    now: () => (now += 1000),
    sleep: () => Promise.resolve(),
  }
  return { deps, calls, stdout, stderr, asked, selectOptions, root, home, mountDir }
}

/** Deletes the fake's temp folder. */
export async function cleanup(fake: Fake): Promise<void> {
  await Deno.remove(fake.root, { recursive: true })
}
