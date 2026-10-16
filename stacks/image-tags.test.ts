// Every catalog image takes its tag from its own variable, `image: repo:${<STACK>_<SERVICE>_IMAGE_TAG:-<default>}`,
// in the one shape `rostok stack add` and `rostok images` discover (cli/images/compose-images.ts).
// An image with a hardcoded tag, no tag, or a variable shared with another service cannot be
// pinned or updated on its own, so the test fails on it.

import { assert, assertEquals } from "@std/assert"
import { parse } from "yaml"
import { parseComposeImages } from "../cli/images/compose-images.ts"

const stacksDir = new URL("./", import.meta.url)

// Tag variables named before the `_IMAGE_TAG` convention. Renaming them would drop the value a
// user already set in a server's `.env`, and the next deploy would switch image.
const LEGACY_NAMES = new Set(["CALDIY_VERSION", "IMMICH_VERSION"])

// Images whose tag is derived from another service's variable on purpose, by stack/service.
const DERIVED = new Map([
  // Immich requires the machine-learning image on the same release as the server, so it reads
  // the server's IMMICH_VERSION with the `-cuda` suffix instead of a variable of its own.
  ["immich/machine-learning", "${IMMICH_VERSION:-release}-cuda"],
])

interface Service {
  image?: unknown
  build?: unknown
}

/** Stack directory names that have a compose.yml, sorted. */
function stacksWithCompose(): string[] {
  const names: string[] = []
  for (const entry of Deno.readDirSync(stacksDir)) {
    if (!entry.isDirectory) continue
    try {
      Deno.statSync(new URL(`./${entry.name}/compose.yml`, stacksDir))
      names.push(entry.name)
    } catch {
      // a stack without containers (deepseek-harness runs under systemd)
    }
  }
  return names.sort()
}

/** The problems with the image lines of one compose file; empty when it follows the rule. */
function tagProblems(stack: string, composeText: string): string[] {
  const services = (parse(composeText) as { services?: Record<string, Service> }).services ?? {}
  const prefix = `${stack.toUpperCase().replaceAll("-", "_")}_`
  const discovered = new Map(parseComposeImages(composeText).map((i) => [i.variable, i]))
  const seen = new Map<string, string>()
  const problems: string[] = []
  for (const [name, service] of Object.entries(services)) {
    const image = service?.image
    if (typeof image !== "string") {
      // Built from the stack's own Dockerfile: no registry, so no tag to pin.
      if (service?.build === undefined) problems.push(`${name}: no image and no build`)
      continue
    }
    const derived = DERIVED.get(`${stack}/${name}`)
    if (derived !== undefined) {
      if (!image.endsWith(`:${derived}`)) problems.push(`${name}: expected tag ${derived}`)
      continue
    }
    const variable = /:\$\{([A-Za-z0-9_]+)[:-]/.exec(image)?.[1]
    if (!variable || !discovered.has(variable) || !image.trim().endsWith("}")) {
      problems.push(`${name}: tag of "${image}" is not one variable with a default`)
      continue
    }
    if (!variable.startsWith(prefix)) problems.push(`${name}: ${variable} lacks ${prefix}`)
    if (!variable.endsWith("_IMAGE_TAG") && !LEGACY_NAMES.has(variable)) {
      problems.push(`${name}: ${variable} does not end in _IMAGE_TAG`)
    }
    const other = seen.get(variable)
    if (other) problems.push(`${name}: ${variable} is shared with ${other}`)
    seen.set(variable, name)
  }
  return problems
}

Deno.test("image tags: a hardcoded, missing or shared tag is reported", () => {
  const compose = (images: string[]) =>
    `services:\n${images.map((image, i) => `  s${i}:\n    image: "${image}"\n`).join("")}`
  assertEquals(tagProblems("demo", compose(["demo/app:${DEMO_IMAGE_TAG:-latest}"])), [])
  assertEquals(tagProblems("demo", compose(["demo/app:1.2.3"])).length, 1)
  assertEquals(tagProblems("demo", compose(["demo/app"])).length, 1)
  assertEquals(tagProblems("demo", compose(["demo/app:${DEMO_IMAGE_TAG}"])).length, 1)
  assertEquals(tagProblems("demo", compose(["demo/app:${DEMO_IMAGE_TAG:-}"])).length, 1)
  assertEquals(tagProblems("demo", compose(["demo/app:${DEMO_IMAGE_TAG:?unset}"])).length, 1)
  assertEquals(tagProblems("demo", compose(["demo/app:${OTHER_IMAGE_TAG:-1}"])).length, 1)
  assertEquals(
    tagProblems(
      "demo",
      compose(["demo/a:${DEMO_IMAGE_TAG:-1}", "demo/b:${DEMO_IMAGE_TAG:-1}"]),
    ).length,
    1,
  )
  assertEquals(tagProblems("demo", "services:\n  s:\n    restart: always\n").length, 1)
  assertEquals(tagProblems("demo", "services:\n  s:\n    build: .\n"), [])
})

const stacks = stacksWithCompose()

Deno.test("image tags: the catalog has compose files to check", () => {
  assert(stacks.length > 10)
})

for (const stack of stacks) {
  Deno.test(`${stack} compose.yml: every image tag is its own variable`, async () => {
    const text = await Deno.readTextFile(new URL(`./${stack}/compose.yml`, stacksDir))
    assertEquals(tagProblems(stack, text), [])
  })
}
