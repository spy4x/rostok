// syncthing-specific checks. The checks every +meta.ts shares live in stacks/meta.test.ts.

import { assert, assertEquals } from "@std/assert"
import { parse as parseYaml } from "yaml"
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

Deno.test("syncthing +meta.ts: the GUI password is required, secret and generated", () => {
  const spec = meta.variables.find((v) => v.key === "SYNCTHING_GUI_PASSWORD")!
  assertEquals(spec.required, true)
  assertEquals(spec.secret, true)
  const password = (spec.default as () => string)()
  assert(password.length >= 32, `generated password too short: ${password.length}`)
  assertEquals(meta.variables.find((v) => v.key === "SYNCTHING_GUI_USER")?.required, true)
})

Deno.test("syncthing compose.yml: refuses to start without the GUI login variables", () => {
  assert(compose.includes("SYNCTHING_GUI_USER=${SYNCTHING_GUI_USER:?}"))
  assert(compose.includes("SYNCTHING_GUI_PASSWORD=${SYNCTHING_GUI_PASSWORD:?}"))
})

Deno.test("syncthing compose.yml: the start script sets the login only in its no-password branch, then starts Syncthing last", () => {
  const entrypoint = (parseYaml(compose) as {
    services: { syncthing: { entrypoint: string[] } }
  }).services.syncthing.entrypoint
  assertEquals(entrypoint.slice(0, 2), ["/bin/sh", "-c"])
  const lines = entrypoint[2].split("\n").map((l) => l.trim()).filter(Boolean)
  // Compose turns `$$` into `$`: the container's shell reads the variables, not compose.
  const at = (text: string) => lines.findIndex((l) => l.includes(text))
  const check = at("if grep -q '<password>..*</password>' /var/syncthing/config/config.xml")
  const otherwise = lines.indexOf("else")
  const generate = at(
    '/bin/entrypoint.sh /bin/syncthing generate --gui-user="$$SYNCTHING_GUI_USER" --gui-password=-',
  )
  const done = lines.indexOf("fi")
  const serve = at("exec /bin/entrypoint.sh /bin/syncthing")
  assert(check >= 0, "must look for an existing GUI password first")
  assert(
    check < otherwise && otherwise < generate && generate < done,
    "the login is set only in the branch without a password",
  )
  assert(done < serve && serve === lines.length - 1, "Syncthing starts last")
  assertEquals(lines[0], "set -eu", "a failed `generate` must stop the start")
  assert(
    !entrypoint[2].includes("--gui-password=$"),
    "the password goes in on standard input, not on the command line",
  )
})
