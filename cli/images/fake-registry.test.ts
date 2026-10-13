// A fake `fetch` that answers like Docker Hub, GHCR and Quay do for
// anonymous reads. No tests live here; the other tests in this folder
// import it. Response shapes (status codes, headers, JSON bodies) follow
// what the three registries really send.

export interface FakeRepo {
  /** tag → digest. */
  tags: Record<string, string>
  /** `org.opencontainers.image.source` label of every image in the repository. */
  source?: string
}

export interface FakeRegistry {
  fetch: typeof fetch
  /** Every request made, as `METHOD url`. */
  calls: string[]
  /** Hosts that refuse connections. */
  down: Set<string>
  /** Hosts that answer 429 to everything. */
  rateLimited: Set<string>
}

/** A valid-looking digest from a short label: `sha("a1")` → `sha256:a1a1…`. */
export function sha(label: string): string {
  return `sha256:${label.repeat(64).slice(0, 64)}`
}

const TOKEN_REALMS: Record<string, { realm: string; service: string }> = {
  "registry-1.docker.io": { realm: "https://auth.docker.io/token", service: "registry.docker.io" },
  "ghcr.io": { realm: "https://ghcr.io/token", service: "ghcr.io" },
  "quay.io": { realm: "https://quay.io/v2/auth", service: "quay.io" },
}

/** Tags per page on GHCR and Quay; Docker Hub sends every tag at once. */
const PAGE_SIZE = 3

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

/**
 * Build a fake registry. `repos` is keyed by `<api host>/<repository>`,
 * e.g. `ghcr.io/twin/gatus` or `registry-1.docker.io/library/nginx`.
 */
export function fakeRegistry(repos: Record<string, FakeRepo>): FakeRegistry {
  const calls: string[] = []
  const down = new Set<string>()
  const rateLimited = new Set<string>()
  const tokenFor = (host: string, repository: string) => `anon-${host}-${repository}`

  const fakeFetch = (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input)
    const method = init.method ?? "GET"
    calls.push(`${method} ${url.href}`)
    if (!(init.signal instanceof AbortSignal)) {
      return Promise.reject(new Error(`request without a timeout signal: ${url.href}`))
    }
    const host = Object.keys(TOKEN_REALMS).find((h) =>
      h === url.host || new URL(TOKEN_REALMS[h].realm).host === url.host
    )
    if (!host || down.has(host)) {
      return Promise.reject(new TypeError("error sending request: connection refused"))
    }
    if (rateLimited.has(host)) {
      return Promise.resolve(
        json({ errors: [{ code: "TOOMANYREQUESTS", message: "rate limit exceeded" }] }, 429),
      )
    }

    // Token endpoint.
    const realm = TOKEN_REALMS[host]
    if (url.origin + url.pathname === realm.realm) {
      const scope = /^repository:(.+):pull$/.exec(url.searchParams.get("scope") ?? "")?.[1]
      if (!scope || url.searchParams.get("service") !== realm.service) {
        return Promise.resolve(json({ errors: [{ code: "DENIED" }] }, 403))
      }
      const token = tokenFor(host, scope)
      // Docker Hub sends both names; GHCR and Quay send `token`.
      const body = host === "registry-1.docker.io"
        ? { token, access_token: token, expires_in: 300, issued_at: "2026-01-01T00:00:00Z" }
        : { token }
      return Promise.resolve(json(body))
    }

    const match = /^\/v2\/(.+)\/(manifests|blobs|tags)\/(.+)$/.exec(url.pathname)
    if (!match) return Promise.resolve(json({ errors: [{ code: "NOT_FOUND" }] }, 404))
    const [, repository, kind, reference] = match
    const headers = new Headers(init.headers)
    if (headers.get("authorization") !== `Bearer ${tokenFor(host, repository)}`) {
      return Promise.resolve(json({ errors: [{ code: "UNAUTHORIZED" }] }, 401, {
        "www-authenticate":
          `Bearer realm="${realm.realm}",service="${realm.service}",scope="repository:${repository}:pull"`,
      }))
    }
    const repo = repos[`${host}/${repository}`]
    if (!repo) return Promise.resolve(json({ errors: [{ code: "NAME_UNKNOWN" }] }, 404))

    if (kind === "tags") {
      const names = Object.keys(repo.tags)
      if (host === "registry-1.docker.io") {
        return Promise.resolve(json({ name: repository, tags: names }))
      }
      const last = url.searchParams.get("last")
      const start = last === null ? 0 : names.indexOf(last) + 1
      const page = names.slice(start, start + PAGE_SIZE)
      const more = start + PAGE_SIZE < names.length
      return Promise.resolve(json(
        { name: repository, tags: page },
        200,
        more
          ? { link: `</v2/${repository}/tags/list?last=${page.at(-1)}&n=${PAGE_SIZE}>; rel="next"` }
          : {},
      ))
    }

    const digests = Object.values(repo.tags)
    if (kind === "manifests") {
      const digest = repo.tags[reference] ??
        (digests.includes(reference) ? reference : undefined)
      if (reference === sha("ab")) {
        // The one platform manifest every fake index points at.
        return Promise.resolve(json({
          schemaVersion: 2,
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: sha("cf") },
          layers: [],
        }))
      }
      if (!digest) return Promise.resolve(json({ errors: [{ code: "MANIFEST_UNKNOWN" }] }, 404))
      const manifestHeaders = {
        "docker-content-digest": digest,
        "content-type": "application/vnd.oci.image.index.v1+json",
      }
      if (method === "HEAD") {
        return Promise.resolve(new Response(null, { status: 200, headers: manifestHeaders }))
      }
      return Promise.resolve(json(
        {
          schemaVersion: 2,
          mediaType: "application/vnd.oci.image.index.v1+json",
          manifests: [
            { digest: sha("00"), platform: { os: "unknown", architecture: "unknown" } },
            { digest: sha("ab"), platform: { os: "linux", architecture: "amd64" } },
          ],
        },
        200,
        manifestHeaders,
      ))
    }

    if (reference === sha("cf")) {
      const labels = repo.source ? { "org.opencontainers.image.source": repo.source } : {}
      return Promise.resolve(
        json({ architecture: "amd64", os: "linux", config: { Labels: labels } }),
      )
    }
    return Promise.resolve(json({ errors: [{ code: "BLOB_UNKNOWN" }] }, 404))
  }

  return { fetch: fakeFetch as typeof fetch, calls, down, rateLimited }
}
