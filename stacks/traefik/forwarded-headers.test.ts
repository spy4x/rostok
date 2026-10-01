// The opt-in TRAEFIK_FORWARDED_TRUSTED_IPS variable of stacks/traefik/compose.yml, rendered the
// way Compose expands `${VAR:-default}`.

import { assertEquals } from "@std/assert"

import meta from "./+meta.ts"

const FLAG = "--entrypoints.websecure.forwardedHeaders.trustedIPs="

/** Compose's `${KEY:-fallback}` expansion over `text`, with `env` as the environment. */
function expand(text: string, env: Record<string, string>): string {
  return text.replace(
    /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g,
    (_, key: string, fallback = "") => env[key] || fallback,
  )
}

async function renderedFlags(env: Record<string, string>): Promise<string[]> {
  const compose = await Deno.readTextFile(new URL("./compose.yml", import.meta.url))
  return expand(compose, env).split("\n")
    .map((l) => l.trim().replace(/^- "?|"$/g, ""))
    .filter((l) => l.startsWith(FLAG))
}

Deno.test("empty TRAEFIK_FORWARDED_TRUSTED_IPS leaves the trusted list empty", async () => {
  assertEquals(await renderedFlags({}), [FLAG])
  assertEquals(await renderedFlags({ TRAEFIK_FORWARDED_TRUSTED_IPS: "" }), [FLAG])
})

Deno.test("TRAEFIK_FORWARDED_TRUSTED_IPS feeds the websecure trustedIPs flag", async () => {
  assertEquals(
    await renderedFlags({ TRAEFIK_FORWARDED_TRUSTED_IPS: "192.0.2.10/32,198.51.100.0/24" }),
    [`${FLAG}192.0.2.10/32,198.51.100.0/24`],
  )
})

Deno.test("TRAEFIK_FORWARDED_TRUSTED_IPS is optional and defaults to empty in +meta.ts", () => {
  const v = meta.variables.find((v) => v.key === "TRAEFIK_FORWARDED_TRUSTED_IPS")
  assertEquals(v?.required, false)
  assertEquals(v?.default, "")
})
