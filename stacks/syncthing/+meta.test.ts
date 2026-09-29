// syncthing-specific checks. The checks every +meta.ts shares live in stacks/meta.test.ts.

import { assert, assertEquals } from "@std/assert"
import type { StackMeta } from "../../cli/stack-meta.ts"
import meta from "./+meta.ts"

const compose = await Deno.readTextFile(new URL("./compose.yml", import.meta.url))

Deno.test("syncthing +meta.ts: the API key default is secret and passes the deploy guard", () => {
  const spec = meta.variables.find((v) => v.key === "SYNCTHING_API_KEY")!
  assertEquals(spec.secret, true)
  assertEquals(typeof spec.default, "function")
  const key = (spec.default as () => string)()
  assert(key.length >= 16, `generated key too short: ${key.length}`)
  assert(/^[A-Za-z0-9_-]+$/.test(key), "generated key must be URL-safe")
})

Deno.test("syncthing +meta.ts: requires traefik because compose routes through it", () => {
  assert(compose.includes("traefik.http.routers"))
  assertEquals((meta as StackMeta).requires, ["traefik"])
})
