// SSH helper — interactive AND command modes
// Usage:
//   deno task ssh <server>                # interactive shell (requires TTY)
//   deno task ssh <server> <command...>   # run remote command, return output
//   deno task ssh <server> -t <cmd...>    # run command with TTY allocation
//
// Examples:
//   deno task ssh home                    # interactive shell
//   deno task ssh cloud docker ps         # list containers on cloud
//   deno task ssh offsite uptime          # check uptime remotely
//   deno task ssh home -t htop            # full-screen TUI over SSH

import { error, log } from "../+lib.ts"

const serversDir = "./servers"
const validServers: string[] = []

try {
  for await (const entry of Deno.readDir(serversDir)) {
    if (entry.isDirectory) {
      validServers.push(entry.name)
    }
  }
} catch (err) {
  error(`Failed to scan servers directory: ${err}`)
  Deno.exit(1)
}

const args = Deno.args
if (args.length === 0) {
  error("Usage: deno task ssh <server> [options] [command...]")
  log(`Available servers: ${validServers.join(", ")}`)
  Deno.exit(1)
}

const server = args[0]

if (!validServers.includes(server)) {
  error(`Invalid server: ${server}`)
  log(`Available servers: ${validServers.join(", ")}`)
  Deno.exit(1)
}

// Load server config to get SSH address
const serverEnvPath = `./servers/${server}/.env`
let sshAddress = ""

try {
  const envContent = await Deno.readTextFile(serverEnvPath)
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.startsWith("SSH_ADDRESS=")) {
      sshAddress = trimmed.split("=").slice(1).join("=").replace(/["']/g, "")
      break
    }
  }

  if (!sshAddress) {
    error(`SSH_ADDRESS not found in ${serverEnvPath}`)
    error("Run 'deno task env:decrypt' first if .env file is missing or encrypted.")
    Deno.exit(1)
  }
} catch (err) {
  error(`Failed to read ${serverEnvPath}: ${err}`)
  error("Run 'deno task env:decrypt' first to decrypt .env files.")
  Deno.exit(1)
}

// Parse rest args for TTY flag and remote command
const restArgs = args.slice(1)
const ttyIndex = restArgs.indexOf("-t")
const needsTty = ttyIndex !== -1
const cmdArgs = needsTty
  ? [...restArgs.slice(0, ttyIndex), ...restArgs.slice(ttyIndex + 1)]
  : restArgs

if (cmdArgs.length > 0) {
  // === Command execution mode (non-interactive) ===
  // Runs a command on the remote server and returns output.
  // This is the mode that works with AI tools / CI / scripting.
  // Must capture output via piped so caller can read results.
  const sshArgs = needsTty ? ["-t", sshAddress, ...cmdArgs] : [sshAddress, ...cmdArgs]

  const cmd = new Deno.Command("ssh", {
    args: sshArgs,
    stdin: "inherit",
    stdout: "piped",
    stderr: "piped",
  })

  const output = await cmd.output()
  Deno.stdout.writeSync(output.stdout)
  Deno.stderr.writeSync(output.stderr)
  Deno.exit(output.code)
} else {
  // === Interactive shell mode ===
  // Opens an interactive SSH session. Requires a real TTY.
  if (!Deno.stdout.isTerminal()) {
    error("Interactive SSH requires a TTY.")
    error("To run a remote command non-interactively, use:")
    error(`  deno task ssh ${server} <command>`)
    error("")
    error("Examples:")
    error(`  deno task ssh ${server} docker ps`)
    error(`  deno task ssh ${server} ls -la /opt`)
    error(`  deno task ssh ${server} -t htop`)
    Deno.exit(1)
  }

  const cmd = new Deno.Command("ssh", {
    args: [sshAddress],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })

  const status = await cmd.output()
  Deno.exit(status.code)
}
