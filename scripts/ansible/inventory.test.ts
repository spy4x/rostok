// Runs the real inventory script against a fixture `servers/` tree and
// checks the JSON it prints — a plain unit test can't catch "ansible
// dynamic inventory" bugs like a missing top-level key, since nothing
// else in this repo calls inventory.ts's main() directly.

import { assertEquals } from "@std/assert"
import { join } from "@std/path"

interface Inventory {
  _meta: { hostvars: Record<string, Record<string, unknown>> }
}

async function runInventory(projectDir: string): Promise<Inventory> {
  const inventoryTs = new URL("./inventory.ts", import.meta.url).pathname
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", inventoryTs, "--list"],
    cwd: projectDir,
    stdout: "piped",
    stderr: "piped",
  })
  const out = await cmd.output()
  if (!out.success) {
    throw new Error(`inventory.ts failed: ${new TextDecoder().decode(out.stderr)}`)
  }
  return JSON.parse(new TextDecoder().decode(out.stdout))
}

async function withServerEnv(envLines: string[], fn: (projectDir: string) => Promise<void>) {
  const projectDir = await Deno.makeTempDir({ prefix: "rostok-inventory-" })
  try {
    const serverDir = join(projectDir, "servers", "home")
    await Deno.mkdir(serverDir, { recursive: true })
    await Deno.writeTextFile(join(serverDir, ".env"), envLines.join("\n") + "\n")
    await fn(projectDir)
  } finally {
    await Deno.remove(projectDir, { recursive: true })
  }
}

Deno.test("inventory: ssh_user is populated from the resolved SSH_USER", async () => {
  await withServerEnv(
    ["SSH_ADDRESS=homelab-alias", "SSH_USER=deploy"],
    async (projectDir) => {
      const inventory = await runInventory(projectDir)
      const hostvars = inventory._meta.hostvars.home
      // Playbooks reference {{ ssh_user }} directly. Before this PR it
      // was a group var, `"{{ lookup('env', 'HOMELAB_USER') }}"` —
      // Ansible's lookup('env', ...) returns an empty string for an
      // unset var, not an error, so playbooks silently ran with
      // ssh_user="" instead of failing loudly. Per-host and resolved
      // from SSH_USER now, so that doesn't happen.
      assertEquals(hostvars.ssh_user, "deploy")
      assertEquals(hostvars.ansible_user, "deploy")
    },
  )
})

Deno.test("inventory: a .env with only HOMELAB_USER (no SSH_USER) has no remote user", async () => {
  await withServerEnv(
    ["SSH_ADDRESS=homelab-alias", "HOMELAB_USER=legacyuser"],
    async (projectDir) => {
      const inventory = await runInventory(projectDir)
      const hostvars = inventory._meta.hostvars.home
      // HOMELAB_USER is no longer read — falls back to the "homelab"
      // default, same as no key set at all.
      assertEquals(hostvars.ssh_user, "homelab")
    },
  )
})

Deno.test("inventory: ssh_user prefers the user@host parsed from SSH_ADDRESS", async () => {
  await withServerEnv(
    ["SSH_ADDRESS=deploy@example.com", "SSH_USER=should-be-overridden-by-address"],
    async (projectDir) => {
      const inventory = await runInventory(projectDir)
      const hostvars = inventory._meta.hostvars.home
      assertEquals(hostvars.ssh_user, "deploy")
      assertEquals(hostvars.ansible_host, "example.com")
    },
  )
})

Deno.test('inventory: ssh_user falls back to "homelab" with no key and no user@host', async () => {
  await withServerEnv(
    ["SSH_ADDRESS=homelab-alias"],
    async (projectDir) => {
      const inventory = await runInventory(projectDir)
      const hostvars = inventory._meta.hostvars.home
      assertEquals(hostvars.ssh_user, "homelab")
    },
  )
})
