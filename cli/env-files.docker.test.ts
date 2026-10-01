// #313: a real `docker compose` run over a `.env` the CLI wrote. Needs
// docker with the compose plugin, which CI does not have, so it runs only
// with ROSTOK_DOCKER_TESTS=1 and then fails (never skips) when docker is
// missing:
//
//   ROSTOK_DOCKER_TESTS=1 deno test --allow-env --allow-run -R -W cli/env-files.docker.test.ts

import { assertEquals } from "@std/assert"
import { join } from "@std/path"
import { encodeEnvValue, writeEnvFilePreservingFormat } from "./env-files.ts"

const VALUES: Record<string, string> = {
  PW_PLAIN: "p$ssw0rd",
  PW_PAIR: "a$$b",
  PW_TEMPLATE: "x${Y}z",
  PW_TRAILING: "end$",
}

const COMPOSE_YML = `services:
  interpolated:
    image: example.invalid/none
    environment:
${Object.keys(VALUES).map((k) => `      ${k}: \${${k}}`).join("\n")}
  from-env-file:
    image: example.invalid/none
    env_file: .env
`

async function compose(dir: string, ...args: string[]) {
  const out = await new Deno.Command("docker", {
    args: ["compose", "--env-file", ".env", ...args],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output()
  const stderr = new TextDecoder().decode(out.stderr)
  assertEquals(out.success, true, stderr)
  return { stdout: new TextDecoder().decode(out.stdout), stderr }
}

Deno.test({
  name: "docker compose reads a $ value the CLI wrote exactly, without a warning (#313)",
  ignore: Deno.env.get("ROSTOK_DOCKER_TESTS") !== "1",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "rostok-dollar-" })
    try {
      await writeEnvFilePreservingFormat(
        join(dir, ".env"),
        Object.entries(VALUES).map(([key, value]) => ({ key, value: encodeEnvValue(key, value) })),
      )
      await Deno.writeTextFile(join(dir, "compose.yml"), COMPOSE_YML)

      // The interpolation environment, as compose read it from `--env-file`.
      const env = await compose(dir, "config", "--environment")
      const interpolation = Object.fromEntries(
        env.stdout.split("\n").filter((l) => l.startsWith("PW_")).map((l) => {
          const eq = l.indexOf("=")
          return [l.slice(0, eq), l.slice(eq + 1)]
        }),
      )
      assertEquals(interpolation, VALUES)

      // The container environment of both services. compose prints its
      // model with every literal `$` written as `$$` (so the output can be
      // read back), hence the doubled expectation.
      const model = await compose(dir, "config", "--format", "json")
      const escaped = Object.fromEntries(
        Object.entries(VALUES).map(([k, v]) => [k, v.replaceAll("$", () => "$$")]),
      )
      const services = JSON.parse(model.stdout).services
      assertEquals(services["interpolated"].environment, escaped)
      assertEquals(services["from-env-file"].environment, escaped)

      for (const stderr of [env.stderr, model.stderr]) {
        assertEquals(stderr.includes("variable is not set"), false, stderr)
      }
    } finally {
      await Deno.remove(dir, { recursive: true })
    }
  },
})
