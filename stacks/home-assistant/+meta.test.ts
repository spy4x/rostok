// home-assistant-specific checks. The checks every +meta.ts shares live in
// stacks/meta.test.ts.

import { assert } from "@std/assert"

const compose = await Deno.readTextFile(new URL("./compose.yml", import.meta.url))
const composeCode = compose.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n")

Deno.test("home-assistant compose.yml: runs on the host network for LAN discovery", () => {
  assert(/^\s+network_mode:\s*host\s*$/m.test(composeCode))
})
