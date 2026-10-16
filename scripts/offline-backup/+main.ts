#!/usr/bin/env -S deno run -A

import { create } from "./src/create.ts"
import {
  FLAGS_HELP,
  type Options,
  parseOptions,
  USAGE_EXIT_CODE,
  UsageError,
} from "./src/options.ts"
import { restore } from "./src/restore.ts"
import { verify } from "./src/verify-mode.ts"

const USAGE = `
Usage: deno run -A --env-file=<env file> scripts/offline-backup/+main.ts <command> [flags]

Commands:
  create    Create new offline backup
  restore   Restore from offline backup
  verify    Verify existing offline backup drive integrity
  help      Show this help

<env file> holds BACKUP_PATHS and BACKUPS_PASSWORD; repeat --env-file when
they live in two files (a rostok project's .env.root and servers/<name>/.env).

${FLAGS_HELP}

Example, unattended:
  deno run -A --env-file=.env.root scripts/offline-backup/+main.ts create \\
    --drive sda --verify fast --smart short
`

// Settings come from the process environment only: pass your project's env
// files with --env-file. Nothing is read from the directory this runs in.
const envVars: Record<string, string> = Deno.env.toObject()

const [commandArg, ...flagArgs] = Deno.args
const command = commandArg?.toLowerCase()

if (!command || ["help", "--help", "-h"].includes(command)) {
  console.log(USAGE)
  Deno.exit(0)
}

const commands: Record<string, (env: Record<string, string>, options: Options) => Promise<void>> = {
  create,
  restore,
  verify,
}

let options: Options
try {
  options = parseOptions(flagArgs, Deno.stdin.isTerminal())
} catch (error) {
  if (!(error instanceof UsageError)) throw error
  console.error(`❌ ${error.message}`)
  console.error("Run 'deno run -A scripts/offline-backup/+main.ts help' for usage")
  Deno.exit(USAGE_EXIT_CODE)
}

// Validate required env vars before dispatching
const requiredVars = ["BACKUP_PATHS", "BACKUPS_PASSWORD"]
const missing = requiredVars.filter((k) => !envVars[k])
if (missing.length > 0) {
  console.error(`❌ Missing required environment variables: ${missing.join(", ")}`)
  console.error("   Pass the env file(s) that define them with --env-file.")
  Deno.exit(1)
}

if (!commands[command]) {
  console.error(`Unknown command: ${commandArg}`)
  console.error("Run 'deno run -A scripts/offline-backup/+main.ts help' for usage")
  Deno.exit(1)
}

try {
  await commands[command](envVars, options)
} catch (error) {
  if (!(error instanceof UsageError)) throw error
  console.error(`❌ ${error.message}`)
  Deno.exit(USAGE_EXIT_CODE)
}
