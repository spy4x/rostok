// Guards the published ports in compose.yml (spy4x/rostok#8): a deploy with default answers must
// not answer DNS queries from the internet. Also guards who can reach the first-run setup wizard
// (spy4x/rostok#427): whoever finishes it owns the DNS server.

import { assertEquals } from "@std/assert"
import { join } from "@std/path"
import { parse } from "yaml"
import { renderCompose } from "../compose-interpolate.ts"

interface Compose {
  services: Record<string, { ports: string[]; entrypoint: string[]; command: string[] }>
}

/** The adguard service when the server's `.env` holds `env`. */
async function adguard(env: Record<string, string>): Promise<Compose["services"][string]> {
  const compose = parse(await renderCompose("adguard", env)) as Compose
  return compose.services.adguard
}

/** The ports the server publishes when the server's `.env` holds `env`. */
async function publishedPorts(env: Record<string, string>): Promise<string[]> {
  return (await adguard(env)).ports
}

/**
 * The arguments the container's start command passes to AdGuardHome, run with `sh` in a
 * throwaway copy of /opt/adguardhome whose AdGuardHome prints its arguments. `configured` writes
 * the config file the setup wizard creates.
 */
async function startArgs(configured: boolean): Promise<string> {
  const service = await adguard({})
  const dir = await Deno.makeTempDir()
  try {
    await Deno.mkdir(join(dir, "conf"))
    if (configured) await Deno.writeTextFile(join(dir, "conf", "AdGuardHome.yaml"), "http: {}\n")
    await Deno.writeTextFile(join(dir, "AdGuardHome"), `#!/bin/sh\necho "$@"\n`)
    await Deno.chmod(join(dir, "AdGuardHome"), 0o755)
    const [shell, flag] = service.entrypoint
    const script = service.command[0].replaceAll("/opt/adguardhome/", `${dir}/`)
    const out = await new Deno.Command(shell, { args: [flag, script] }).output()
    assertEquals(out.code, 0, new TextDecoder().decode(out.stderr))
    return new TextDecoder().decode(out.stdout).trim().replaceAll(`${dir}/`, "/opt/adguardhome/")
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

Deno.test("adguard: without ADGUARD_DNS_BIND every port is published on loopback only", async () => {
  assertEquals(await publishedPorts({}), [
    "127.0.0.1:53:53/tcp",
    "127.0.0.1:53:53/udp",
    "127.0.0.1:853:853/tcp",
  ])
})

Deno.test("adguard: ADGUARD_DNS_BIND moves the DNS ports to that address", async () => {
  assertEquals(await publishedPorts({ ADGUARD_DNS_BIND: "192.0.2.10" }), [
    "192.0.2.10:53:53/tcp",
    "192.0.2.10:53:53/udp",
    "192.0.2.10:853:853/tcp",
  ])
})

Deno.test("adguard: before the first setup it binds the wizard to the container's loopback", async () => {
  assertEquals(
    await startArgs(false),
    "--no-check-update -c /opt/adguardhome/conf/AdGuardHome.yaml -w /opt/adguardhome/work " +
      "--web-addr 127.0.0.1:3000",
  )
})

Deno.test("adguard: once set up it starts with the image's own arguments and no --web-addr", async () => {
  assertEquals(
    await startArgs(true),
    "--no-check-update -c /opt/adguardhome/conf/AdGuardHome.yaml -w /opt/adguardhome/work",
  )
})
