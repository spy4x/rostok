// Ansible wrapper script that loads environment variables and runs ansible-playbook
// Usage: deno run -A scripts/ansible/+main.ts <playbook> <target>
// Example: deno run -A scripts/ansible/+main.ts ansible/playbooks/maintenance.yml offsite

import { error, log, success } from "../+lib.ts"
import { load } from "@std/dotenv"

// Parse command line arguments
const args = Deno.args
if (args.length < 2) {
  error("Usage: deno run -A scripts/ansible/+main.ts <playbook> <target> [ansible-options]")
  error("Example: deno run -A scripts/ansible/+main.ts ansible/playbooks/maintenance.yml offsite")
  error("Note: --ask-become-pass is automatically included for all playbooks")
  Deno.exit(1)
}

const [playbookPath, target, ...extraArgs] = args

// Validate target directory exists
try {
  await Deno.stat(`./servers/${target}`)
} catch {
  error(`Target '${target}' does not exist. Expected directory: ./servers/${target}`)
  Deno.exit(1)
}

// Load environment variables from root .env
const rootEnvPath = "./.env.root"
const rootEnv = await load({ envPath: rootEnvPath })

// Load environment variables from target's server folder .env
const targetEnvPath = `./servers/${target}/.env`
const targetEnv = await load({ envPath: targetEnvPath })

// Merge all environment variables (later ones override earlier ones)
const mergedEnv = { ...Deno.env.toObject(), ...rootEnv, ...targetEnv }

// Add SSH_PORT from the appropriate source
if (targetEnv.SSH_PORT) {
  mergedEnv.SSH_PORT = targetEnv.SSH_PORT
} else if (rootEnv[`SSH_PORT_${target.toUpperCase()}`]) {
  mergedEnv.SSH_PORT = rootEnv[`SSH_PORT_${target.toUpperCase()}`]
}

log(
  `Running ansible-playbook ${playbookPath} for target: ${target}${
    extraArgs.length ? ` with options: ${extraArgs.join(" ")}` : ""
  }`,
)

// Run ansible-playbook with dynamic inventory script and merged environment variables
const command = new Deno.Command("ansible-playbook", {
  args: [
    playbookPath,
    "-i",
    "./scripts/ansible/inventory.ts",
    "--limit",
    target,
    "--ask-become-pass", // Always ask for sudo password since all playbooks need it
    ...extraArgs, // Pass through any additional arguments
  ],
  env: mergedEnv,
  stdout: "inherit",
  stderr: "inherit",
})

const { code } = await command.output()

if (code !== 0) {
  error(`ansible-playbook failed with exit code ${code}`)
  Deno.exit(code)
}

success("Ansible playbook completed successfully")
