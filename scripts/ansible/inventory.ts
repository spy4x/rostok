#!/usr/bin/env -S deno run -A
// Dynamic Ansible Inventory Script
// Returns JSON inventory to stdout for Ansible to consume
// Usage: ansible-playbook -i scripts/ansible/inventory.ts playbook.yml

import { load } from "@std/dotenv"
import { resolveSshUser } from "../../cli/deploy/env.ts"

interface ServerConfig {
  server: string
  backup?: {
    cronHour?: number
    cronMinute?: number
  }
  fail2ban?: {
    jails?: Array<{
      name: string
      container: string
      maxretry?: number
      bantime?: string
      findtime?: string
    }>
  }
}

async function getServers(): Promise<string[]> {
  const servers: string[] = []
  for await (const entry of Deno.readDir("./servers")) {
    if (entry.isDirectory) {
      servers.push(entry.name)
    }
  }
  return servers.sort()
}

async function loadServerConfig(server: string): Promise<ServerConfig> {
  const configPath = `./servers/${server}/config.json`
  try {
    const content = await Deno.readTextFile(configPath)
    return JSON.parse(content)
  } catch {
    return { server }
  }
}

async function loadServerEnv(server: string): Promise<Record<string, string>> {
  const envPath = `./servers/${server}/.env`
  try {
    return await load({ envPath })
  } catch {
    return {}
  }
}

async function main() {
  // Handle Ansible dynamic inventory protocol
  const args = Deno.args

  // --host <hostname> should return empty JSON (we put all vars in --list)
  if (args.length >= 2 && args[0] === "--host") {
    console.log(JSON.stringify({}))
    return
  }

  // --list returns the full inventory
  const servers = await getServers()

  // Build inventory structure
  // deno-lint-ignore no-explicit-any
  const inventory: Record<string, any> = {
    _meta: {
      // deno-lint-ignore no-explicit-any
      hostvars: {} as Record<string, any>,
    },
    all: {
      children: ["homelab_servers"],
    },
    homelab_servers: {
      hosts: [] as string[],
      vars: {
        ansible_python_interpreter: "/usr/bin/python3",
      },
    },
  }

  for (const server of servers) {
    const env = await loadServerEnv(server)
    const _config = await loadServerConfig(server)
    const envPath = `./servers/${server}/.env`

    // SSH_USER ← HOMELAB_USER ← USER (read from the file, never the shell's
    // own $USER — see cli/deploy/env.ts).
    const resolvedUser = resolveSshUser(env, envPath)
    if (resolvedUser.notice) console.error(resolvedUser.notice)

    // Parse SSH_ADDRESS for user@host format
    let user = resolvedUser.value || "homelab"
    let host = env.SSH_ADDRESS || ""
    if (host.includes("@")) {
      const parts = host.split("@")
      user = parts[0]
      host = parts[1]
    }

    // Determine paths based on user and env
    const denoInstallPath = `/home/${user}/.deno`
    const homeDir = `/home/${user}`

    // Expand tilde in PATH_APPS and PATH_BACKUPS
    let appsPath = env.PATH_APPS || "~/apps"
    if (appsPath.startsWith("~/")) {
      appsPath = appsPath.replace("~/", `${homeDir}/`)
    }

    let backupsPath = env.PATH_BACKUPS || "~/backups"
    if (backupsPath.startsWith("~/")) {
      backupsPath = backupsPath.replace("~/", `${homeDir}/`)
    }

    // Derive volumes path (VOLUMES_PATH env or default under apps)
    let volumesPath = env.VOLUMES_PATH || `${appsPath}/.volumes`
    if (volumesPath.startsWith("~/")) {
      volumesPath = volumesPath.replace("~/", `${homeDir}/`)
    }

    // Repo checkout location for the backup cron. The backup script and
    // its root env file live in the source checkout (`scripts/backup/`
    // and `.env.root`), not in the deployed apps dir (`apps_path` is
    // typically a Synced deploy target that only carries `.env`,
    // `stacks/`, and `.volumes/`). Hardcoding the cron to `apps_path`
    // broke silently when the repo dir was renamed; let each host pin
    // its checkout via `REPO_PATH` in `servers/<server>/.env`, with a
    // `${PATH_SYNC}/code/rostok` fallback for hosts that use Syncthing
    // to mirror the repo under `PATH_SYNC`.
    let repoPath = env.REPO_PATH || `${env.PATH_SYNC || "~/sync"}/code/rostok`
    if (repoPath.startsWith("~/")) {
      repoPath = repoPath.replace("~/", `${homeDir}/`)
    }

    // Default to root for backward compatibility with hosts whose cron
    // already runs as root; portable/portable-like hosts can override
    // via `BACKUP_CRON_USER` in `servers/<server>/.env`.
    const backupCronUser = env.BACKUP_CRON_USER || "root"

    const backupLogPath = `${homeDir}/backup.log`
    const envFilePath = `${appsPath}/.env`
    const rootEnvFilePath = `${appsPath}/.env.root`

    // Add host to the hosts list
    inventory.homelab_servers.hosts.push(server)

    // Add host variables to _meta.hostvars
    inventory._meta.hostvars[server] = {
      ansible_host: host,
      ansible_user: user,
      ansible_ssh_private_key_file:
        "{{ lookup('env', 'SSH_PRIVATE_KEY_FILE') | default('~/.ssh/id_ed25519', true) }}",
      ssh_port: "{{ lookup('env', 'SSH_PORT') }}",
      deno_install_path: denoInstallPath,
      apps_path: appsPath,
      volumes_path: volumesPath,
      backup_log_path: backupLogPath,
      env_file_path: envFilePath,
      root_env_file_path: rootEnvFilePath,
      backups_path: backupsPath,
      repo_path: repoPath,
      backup_cron_user: backupCronUser,
    }
  }

  // Output JSON to stdout for Ansible
  console.log(JSON.stringify(inventory, null, 2))
}

if (import.meta.main) {
  main()
}
