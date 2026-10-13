import { assertEquals, assertRejects } from "@std/assert"
import { join } from "@std/path"
import { UserError } from "../errors.ts"
import { resolveImagePolicy } from "./policy.ts"

/** A project with one server, `home`; undefined leaves that file's policy out. */
async function withProject<T>(
  rootEnv: string | undefined,
  serverEnv: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "rostok-image-policy-" })
  try {
    await Deno.mkdir(join(dir, "servers", "home"), { recursive: true })
    if (rootEnv !== undefined) await Deno.writeTextFile(join(dir, ".env.root"), rootEnv)
    await Deno.writeTextFile(join(dir, "servers", "home", ".env"), serverEnv)
    return await fn(dir)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

Deno.test("image policy is pinned when neither file sets it, also with no .env.root or an empty value", async () => {
  await withProject("OTHER=1\n", "DOMAIN=example.com\n", async (dir) => {
    assertEquals(await resolveImagePolicy(dir, "home"), "pinned")
  })
  await withProject(undefined, "DOMAIN=example.com\n", async (dir) => {
    assertEquals(await resolveImagePolicy(dir, "home"), "pinned")
  })
  await withProject("IMAGE_POLICY=\n", "IMAGE_POLICY=\n", async (dir) => {
    assertEquals(await resolveImagePolicy(dir, "home"), "pinned")
  })
})

Deno.test("image policy comes from the project's .env.root", async () => {
  await withProject("IMAGE_POLICY=latest\n", "DOMAIN=example.com\n", async (dir) => {
    assertEquals(await resolveImagePolicy(dir, "home"), "latest")
  })
})

Deno.test("a server's .env overrides the project's image policy, in both directions", async () => {
  await withProject("IMAGE_POLICY=latest\n", "IMAGE_POLICY=pinned\n", async (dir) => {
    assertEquals(await resolveImagePolicy(dir, "home"), "pinned")
  })
  await withProject("IMAGE_POLICY=pinned\n", 'IMAGE_POLICY="latest"\n', async (dir) => {
    assertEquals(await resolveImagePolicy(dir, "home"), "latest")
  })
})

Deno.test("an image policy other than pinned or latest is an error that names the file", async () => {
  await withProject("IMAGE_POLICY=newest\n", "DOMAIN=example.com\n", async (dir) => {
    await assertRejects(
      () => resolveImagePolicy(dir, "home"),
      UserError,
      `${join(dir, ".env.root")}: IMAGE_POLICY must be "pinned" or "latest", not "newest"`,
    )
  })
  await withProject("IMAGE_POLICY=latest\n", "IMAGE_POLICY=Pinned\n", async (dir) => {
    await assertRejects(
      () => resolveImagePolicy(dir, "home"),
      UserError,
      `${join(dir, "servers", "home", ".env")}: IMAGE_POLICY must be`,
    )
  })
})
