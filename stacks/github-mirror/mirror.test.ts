import { assertEquals, assertRejects } from "@std/assert"
import { type MirrorConfig, mirrorNew } from "./mirror.ts"

const config: MirrorConfig = {
  githubToken: "gh-test",
  giteaUrl: "http://gitea.test",
  giteaToken: "gt-test",
}

interface Call {
  method: string
  url: string
  body?: Record<string, unknown>
}

const repo = (name: string, isPrivate = false) => ({
  name,
  clone_url: `https://github.com/someone/${name}.git`,
  private: isPrivate,
  description: null,
  owner: { login: "someone" },
})

/** A fake GitHub and Gitea: `githubPages` are the repository pages, `giteaRepos` what exists. */
function fakeFetch(
  githubPages: unknown[][],
  giteaRepos: Set<string>,
  overrides: Record<string, number> = {},
) {
  const calls: Call[] = []
  const fn = (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url, body })
    const json = (status: number, data: unknown = {}) =>
      Promise.resolve(new Response(JSON.stringify(data), { status }))
    const forced = overrides[`${method} ${url}`]
    if (forced) return json(forced)
    const page = /api\.github\.com\/user\/repos\?.*page=(\d+)/.exec(url)
    if (page) return json(200, githubPages[Number(page[1]) - 1] ?? [])
    if (url === "http://gitea.test/api/v1/user") return json(200, { login: "me" })
    const existing = /\/api\/v1\/repos\/me\/(.+)$/.exec(url)
    if (method === "GET" && existing) return json(giteaRepos.has(existing[1]) ? 200 : 404)
    if (method === "POST" && url.endsWith("/api/v1/repos/migrate")) return json(201)
    return json(500)
  }
  return { fn: fn as typeof fetch, calls }
}

Deno.test("mirrorNew: creates a mirror only for repositories Gitea does not have", async () => {
  const { fn, calls } = fakeFetch([[repo("kept"), repo("new", true)]], new Set(["kept"]))
  assertEquals(await mirrorNew(config, fn), { created: ["new"], failed: [] })
  const migrations = calls.filter((c) => c.method === "POST")
  assertEquals(migrations.map((c) => c.body), [{
    clone_addr: "https://github.com/someone/new.git",
    repo_name: "new",
    repo_owner: "me",
    mirror: true,
    private: true,
    description: "",
    service: "git",
    auth_username: "someone",
    auth_password: "gh-test",
  }])
})

Deno.test("mirrorNew: reads every GitHub page until a short one", async () => {
  const full = Array.from({ length: 100 }, (_, i) => repo(`r${i}`))
  const all = new Set(full.map((r) => r.name))
  const { fn } = fakeFetch([full, [repo("last")]], all)
  assertEquals(await mirrorNew(config, fn), { created: ["last"], failed: [] })
})

Deno.test("mirrorNew: one failed migration does not stop the next", async () => {
  const { fn } = fakeFetch([[repo("broken"), repo("fine")]], new Set())
  let first = true
  const flaky: typeof fetch = (input, init) => {
    if (init?.method === "POST" && first) {
      first = false
      return Promise.resolve(new Response("{}", { status: 422 }))
    }
    return fn(input, init)
  }
  assertEquals(await mirrorNew(config, flaky), {
    created: ["fine"],
    failed: ["broken (migrate 422)"],
  })
})

Deno.test("mirrorNew: a Gitea lookup error is a failure, not a new mirror", async () => {
  const { fn, calls } = fakeFetch([[repo("odd")]], new Set(), {
    "GET http://gitea.test/api/v1/repos/me/odd": 500,
  })
  assertEquals(await mirrorNew(config, fn), { created: [], failed: ["odd (lookup 500)"] })
  assertEquals(calls.filter((c) => c.method === "POST"), [])
})

Deno.test("mirrorNew: a GitHub listing error throws instead of mirroring nothing", async () => {
  const { fn } = fakeFetch([], new Set(), {
    "GET https://api.github.com/user/repos?affiliation=owner&per_page=100&page=1": 401,
  })
  await assertRejects(() => mirrorNew(config, fn), Error, "GitHub 401")
})
