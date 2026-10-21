/**
 * Rents and deletes the throwaway Hetzner Cloud server the demo video deploys to.
 *
 * ```bash
 * deno run --allow-net=api.hetzner.cloud --allow-env --allow-run=ssh-keygen,ssh -R -W vm.ts up <dir>
 * deno run --allow-net=api.hetzner.cloud --allow-env -R vm.ts down <dir>
 * ```
 *
 * `up` writes a fresh SSH key and `known_hosts` into `<dir>`, registers the key, creates the
 * cheapest x86 server with Docker installed by cloud-init, waits until `docker compose version`
 * answers over SSH, and writes the server's IPv4 address to `<dir>/ip`. `down` deletes the
 * servers and SSH keys of this run (its id is in `<dir>/run-id`) and waits until none is left.
 * Both read `HETZNER_CLOUD_API_TOKEN` from the environment; it goes to the API in a header only.
 * The API calls are the real-server test's (`scripts/e2e-vps/hetzner.ts`), so this script deletes
 * nothing that does not carry its label and this run's id.
 *
 * @module
 */
import { join } from "@std/path"
import {
  cheapestX86,
  createCall,
  createKey,
  createServer,
  deleteLabelled,
  type Kind,
  listLabelled,
  ofRun,
  type Server,
  tokenFromEnv,
} from "../../../scripts/e2e-vps/hetzner.ts"
import { waitFor } from "../../../scripts/e2e-vps/wait.ts"

const CLOUD_INIT = `#cloud-config
runcmd:
  - curl -fsSL https://get.docker.com | sh
`
const KINDS: Kind[] = ["servers", "ssh_keys"]

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const r = await new Deno.Command(argv[0], { args: argv.slice(1), stdin: "null" }).output()
  const d = new TextDecoder()
  return { code: r.code, out: d.decode(r.stdout) + d.decode(r.stderr) }
}

async function up(dir: string): Promise<void> {
  const call = createCall(tokenFromEnv((k) => Deno.env.get(k)), fetch)
  const runId = `demo-${
    new Date().toISOString().replace(/\.\d+Z$/, "z").replace(/[-:]/g, "").toLowerCase()
  }`
  // Written first, so `down` finds this run even when `up` fails half-way.
  await Deno.writeTextFile(join(dir, "run-id"), runId)
  const key = join(dir, "id_ed25519")
  const kg = await run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "demo", "-f", key])
  if (kg.code !== 0) throw new Error(`ssh-keygen failed: ${kg.out}`)
  const keyId = await createKey(call, runId, (await Deno.readTextFile(`${key}.pub`)).trim())

  let server: Server | undefined
  const errors: string[] = []
  // The cheapest type can be sold out in one location; try the next offers in order.
  for (const offer of (await cheapestX86(call)).slice(0, 6)) {
    try {
      server = await createServer(call, runId, offer, keyId, CLOUD_INIT)
      console.log(`created ${offer.type} in ${offer.location} (${offer.hourly} EUR/h)`)
      break
    } catch (err) {
      errors.push(`${offer.type}@${offer.location}: ${(err as Error).message}`)
    }
  }
  if (!server) throw new Error(`no server created:\n${errors.join("\n")}`)
  const id = server.id
  const ip = await waitFor("the server to run", 180_000, async () => {
    const s: Server = (await call("GET", `/servers/${id}`)).server
    return s.status === "running" ? s.public_net?.ipv4?.ip ?? undefined : undefined
  })
  const ssh = [
    "ssh",
    ...["-i", key, "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none"],
    ...["-o", `UserKnownHostsFile=${join(dir, "known_hosts")}`],
    ...["-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes"],
    ...["-o", "ConnectTimeout=10", `root@${ip}`],
  ]
  await waitFor("Docker on the server", 600_000, async () => {
    const r = await run([
      ...ssh,
      "test -f /var/lib/cloud/instance/boot-finished && docker compose version",
    ])
    if (r.code !== 0) throw new Error(r.out.trim().split("\n").at(-1) ?? "")
    return true
  })
  await Deno.writeTextFile(join(dir, "ip"), ip)
  console.log("server is up, Docker answers")
}

async function down(dir: string): Promise<void> {
  let runId: string
  try {
    runId = (await Deno.readTextFile(join(dir, "run-id"))).trim()
  } catch {
    console.log("no run id: nothing was created")
    return
  }
  const call = createCall(tokenFromEnv((k) => Deno.env.get(k)), fetch)
  const mine = ofRun(runId)
  await waitFor(`every object of run ${runId} to be deleted`, 180_000, async () => {
    let left = 0
    for (const kind of KINDS) {
      left += (await listLabelled(call, kind)).filter(mine).length
      // A server that is still being created refuses the delete; the next round retries.
      for (const name of await deleteLabelled(call, kind, mine).catch(() => [])) {
        console.log(`deleted ${kind} ${name}`)
      }
    }
    return left === 0 ? true : undefined
  })
  console.log(`run ${runId}: no server or SSH key left`)
}

if (import.meta.main) {
  const [cmd, dir] = Deno.args
  try {
    if (cmd === "up" && dir) await up(dir)
    else if (cmd === "down" && dir) await down(dir)
    else throw new Error("usage: vm.ts up <dir> | down <dir>")
  } catch (err) {
    console.error((err as Error).message)
    Deno.exit(1)
  }
}
