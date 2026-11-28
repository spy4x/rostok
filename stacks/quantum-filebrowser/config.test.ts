// Guards the sign-in settings and the source of config.yaml against a rewrite: the app is on the
// internet with only its own login in front of the mounted files.

import { assertEquals } from "@std/assert"
import { parse } from "yaml"

interface Config {
  server: { disableUpdateCheck: boolean; sources: { path: string }[] }
  auth: { methods: { noauth: boolean; password: { enabled: boolean; signup: boolean } } }
}

const config = parse(
  await Deno.readTextFile(new URL("./config.yaml", import.meta.url)),
) as Config

Deno.test("quantum-filebrowser config.yaml: every request needs a signed-in user", () => {
  assertEquals(config.auth.methods.noauth, false)
  assertEquals(config.auth.methods.password.enabled, true)
})

Deno.test("quantum-filebrowser config.yaml: nobody can sign themselves up", () => {
  assertEquals(config.auth.methods.password.signup, false)
})

Deno.test("quantum-filebrowser config.yaml: the one source is the /srv tree compose mounts", () => {
  assertEquals(config.server.sources.map((s) => s.path), ["/srv"])
})

Deno.test("quantum-filebrowser config.yaml: the update check is off", () => {
  assertEquals(config.server.disableUpdateCheck, true)
})
