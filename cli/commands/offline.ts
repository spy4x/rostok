// `rostok offline status|backup|verify|restore|format` — a copy of the
// restic repositories on an external drive. The logic lives in
// cli/offline/; this file only maps flags onto it.

import { Command, EnumType } from "@cliffy/command"
import { runBackup } from "../offline/backup.ts"
import { defaultDeps, type OfflineDeps } from "../offline/context.ts"
import { runFormat } from "../offline/format.ts"
import { runRestore } from "../offline/restore.ts"
import { runStatus } from "../offline/status.ts"
import { CHECK_MODES, SMART_MODES } from "../offline/types.ts"
import { runVerify } from "../offline/verify-mode.ts"

const GROUP_DESCRIPTION = `Keep a copy of the backups on an external drive.

Reads BACKUP_PATHS and BACKUPS_PASSWORD from .env.root in the current folder.
The drive needs one partition labelled OfflineBackups: \`rostok offline format\`
makes it. Linux only.

Examples:

    rostok offline status                     # settings, disks, tools; changes nothing
    rostok offline format --drive sdb         # prepare a new drive (erases it)
    rostok offline backup                     # at a terminal: pick the disk, answer questions
    rostok offline backup --drive sdb -n      # cron or an agent: never asks, never deletes
    rostok offline verify --drive sdb --check full
    rostok offline restore --drive sdb        # copy the drive back over the local folders

Exit codes:

    0  everything finished and every check passed
    1  anything else: a missing setting or tool, a refused confirmation,
       a failed copy, or a check that failed or found nothing to check
       (--check skip is not a failure: the summary says nothing was checked)`

const DRIVE_HELP = "whole disk to use, for example sda or /dev/sda"
const NON_INTERACTIVE_HELP = "never ask; a step that needs an answer stops instead"

/** Builds the group. Tests pass `makeDeps` to run it with fakes. */
export function buildOfflineCommand(
  makeDeps: (cwd: string) => OfflineDeps = defaultDeps,
  // deno-lint-ignore no-explicit-any
): any {
  const deps = () => makeDeps(Deno.cwd())

  return new Command()
    .description(GROUP_DESCRIPTION)
    .action(function () {
      this.showHelp()
    })
    .command(
      "status",
      new Command()
        .description(
          "Show the backup paths with their local sizes, the disks, and the tools. " +
            "Mounts nothing; exits 1 when a required setting or tool is missing.",
        )
        .action(() => runStatus(deps())),
    )
    .command(
      "backup",
      new Command()
        .type("check", new EnumType(CHECK_MODES))
        .type("smart", new EnumType(SMART_MODES))
        .description(`Copy the repositories to the drive, check them, run a SMART test, eject.

Never formats. Repositories that are on the drive but no longer local are
deleted only with --delete-missing, or when you answer yes at a terminal.

Examples:

    rostok offline backup                          # a person at a terminal
    rostok offline backup --drive sdb -n           # cron or an agent
    rostok offline backup --drive sdb -n --check full --smart long`)
        .option("--drive <disk:string>", DRIVE_HELP)
        .option("-n, --non-interactive", NON_INTERACTIVE_HELP)
        .option("--check <mode:check>", "restic check after the copy", { default: "fast" })
        .option("--smart <mode:smart>", "SMART self-test of the drive", { default: "short" })
        .option("--delete-missing", "allow deleting repositories that are no longer local")
        .option("--no-eject", "unmount, but leave the drive powered on")
        .action((options) =>
          runBackup(deps(), {
            drive: options.drive,
            nonInteractive: options.nonInteractive,
            check: options.check,
            smart: options.smart,
            deleteMissing: options.deleteMissing ?? false,
            eject: options.eject,
          })
        ),
    )
    .command(
      "verify",
      new Command()
        .type("check", new EnumType(["fast", "full"] as const))
        .type("smart", new EnumType(SMART_MODES))
        .description(`Check the copies already on the drive; copies nothing.

Examples:

    rostok offline verify --drive sdb
    rostok offline verify --drive sdb -n --check full --smart long`)
        .option("--drive <disk:string>", DRIVE_HELP)
        .option("-n, --non-interactive", NON_INTERACTIVE_HELP)
        .option("--check <mode:check>", "restic check depth", { default: "fast" })
        .option("--smart <mode:smart>", "SMART self-test of the drive", { default: "short" })
        .option("--no-eject", "unmount, but leave the drive powered on")
        .action((options) =>
          runVerify(deps(), {
            drive: options.drive,
            nonInteractive: options.nonInteractive,
            check: options.check,
            smart: options.smart,
            eject: options.eject,
          })
        ),
    )
    .command(
      "restore",
      new Command()
        .description(`Copy the drive's repositories back over the local folders, then check them.

At a terminal you confirm by typing the disk name. Without one, pass
--overwrite-local; -n alone never replaces anything.

Examples:

    rostok offline restore --drive sdb
    rostok offline restore --drive sdb -n --overwrite-local`)
        .option("--drive <disk:string>", DRIVE_HELP)
        .option("-n, --non-interactive", NON_INTERACTIVE_HELP)
        .option("--overwrite-local", "allow replacing the local folders without asking")
        .option("--no-eject", "unmount, but leave the drive powered on")
        .action((options) =>
          runRestore(deps(), {
            drive: options.drive,
            nonInteractive: options.nonInteractive,
            overwriteLocal: options.overwriteLocal ?? false,
            eject: options.eject,
          })
        ),
    )
    .command(
      "format",
      new Command()
        .description(`Erase a disk and create one btrfs partition labelled OfflineBackups.

Refuses the system disk and a disk with anything mounted. At a terminal you
confirm by typing the disk name; without one, pass --confirm with the same
disk as --drive. Needs sudo.

Examples:

    rostok offline format --drive sdb
    rostok offline format --drive sdb -n --confirm sdb`)
        .option("--drive <disk:string>", DRIVE_HELP)
        .option("-n, --non-interactive", NON_INTERACTIVE_HELP)
        .option("--confirm <disk:string>", "the same disk as --drive: confirms the erase")
        .action((options) =>
          runFormat(deps(), {
            drive: options.drive,
            nonInteractive: options.nonInteractive,
            confirm: options.confirm,
          })
        ),
    )
}

export const offlineCommand = buildOfflineCommand()
