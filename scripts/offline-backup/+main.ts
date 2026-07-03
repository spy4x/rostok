#!/usr/bin/env -S deno run -A

import { load } from "@std/dotenv"
import { create } from "./src/create.ts"
import { restore } from "./src/restore.ts"
import { verify } from "./src/verify-mode.ts"

// Load env files
let envVars: Record<string, string> = {}

try {
  const rootEnv = await load({ envPath: ".env.root" })
  envVars = { ...rootEnv }
} catch {
  // .env.root may not exist
}

try {
  const localEnv = await load({ envPath: ".env" })
  envVars = { ...envVars, ...localEnv }
} catch {
  // .env may not exist
}

// Parse command
const args = Deno.args

if (args.length < 1) {
  console.log(`
Usage: deno task offline-backup <command>

Commands:
  create    Create new offline backup
  restore   Restore from offline backup
  verify    Verify existing offline backup drive integrity
  help      Show this help

Examples:
  deno task offline-backup create
  deno task offline-backup restore
  deno task offline-backup verify
`)
  Deno.exit(0)
}

const command = args[0].toLowerCase()

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
Usage: deno task offline-backup <command>

Commands:
  create    Create new offline backup
  restore   Restore from offline backup
  verify    Verify existing offline backup drive integrity
  help      Show this help
`)
    break
  default:
    console.error(`Unknown command: ${command}`)
    console.error("Run 'deno task offline-backup help' for usage")
    Deno.exit(1)
}
