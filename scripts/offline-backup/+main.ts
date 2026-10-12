#!/usr/bin/env -S deno run -A

import { create } from "./src/create.ts"
import { restore } from "./src/restore.ts"
import { verify } from "./src/verify-mode.ts"

// Settings come from the process environment only: pass your project's env
// files with --env-file. Nothing is read from the directory this runs in.
const envVars: Record<string, string> = Deno.env.toObject()

// Parse command
const args = Deno.args

if (args.length < 1) {
  console.log(`
Usage: deno run -A --env-file=<env file> scripts/offline-backup/+main.ts <command>

Commands:
  create    Create new offline backup
  restore   Restore from offline backup
  verify    Verify existing offline backup drive integrity
  help      Show this help

<env file> holds BACKUP_PATHS and BACKUPS_PASSWORD; repeat --env-file when
they live in two files (a rostok project's .env.root and servers/<name>/.env).
`)
  Deno.exit(0)
}

const command = args[0].toLowerCase()

// Validate required env vars before dispatching
const requiredVars = ["BACKUP_PATHS", "BACKUPS_PASSWORD"]
const missing = requiredVars.filter((k) => !envVars[k])
if (missing.length > 0) {
  console.error(`❌ Missing required environment variables: ${missing.join(", ")}`)
  console.error("   Pass the env file(s) that define them with --env-file.")
  Deno.exit(1)
}

switch (command) {
  case "create":
    await create(envVars)
    break
  case "restore":
    await restore(envVars)
    break
  case "verify":
    await verify(envVars)
    break
  case "help":
  case "--help":
  case "-h":
    console.log(`
Usage: deno run -A --env-file=<env file> scripts/offline-backup/+main.ts <command>

Commands:
  create    Create new offline backup
  restore   Restore from offline backup
  verify    Verify existing offline backup drive integrity
  help      Show this help
`)
    break
  default:
    console.error(`Unknown command: ${command}`)
    console.error(
      "Run 'deno run -A --env-file=<env file> scripts/offline-backup/+main.ts help' for usage",
    )
    Deno.exit(1)
}
