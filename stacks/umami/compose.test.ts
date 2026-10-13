// Guards which networks the Umami database can be reached from (spy4x/rostok#380).

import { assertEquals } from "@std/assert"
import { parse } from "yaml"

interface Network {
  external?: boolean
  internal?: boolean
  name?: string
}

interface Compose {
  networks: Record<string, Network | null>
  services: Record<string, { networks?: string[] }>
}

const compose = parse(
  await Deno.readTextFile(new URL("./compose.yml", import.meta.url)),
) as Compose

/** The network a service key resolves to: its `name`, or the key when the project owns it. */
function resolved(key: string): Network & { key: string } {
  return { key, ...(compose.networks[key] ?? {}) }
}

Deno.test("umami: the database joins only the stack's own internal network", () => {
  // A service without `networks` would join the project's default network, which every stack
  // with `name: ${PROJECT}` shares: the list must be explicit.
  assertEquals(compose.services["umami-db"].networks, ["umami-db"])
  // Not external and not renamed, so no other stack can declare it; internal, so no route out.
  assertEquals(resolved("umami-db"), { key: "umami-db", internal: true })
})

Deno.test("umami: no network of the stack other than `proxy` resolves to the proxy network", () => {
  // The old file aliased `default` to the external `proxy` network.
  const aliases = Object.keys(compose.networks)
    .filter((key) => key !== "proxy" && (resolved(key).name ?? key) === "proxy")
  assertEquals(aliases, [])
})

Deno.test("umami: the app joins the proxy network for Traefik and the database network", () => {
  assertEquals(compose.services["umami"].networks, ["proxy", "umami-db"])
})
