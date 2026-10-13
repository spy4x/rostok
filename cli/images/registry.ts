// One small client for the container registries the catalog uses:
// Docker Hub, GHCR and Quay, read anonymously over the registry v2 API.
//
// Every request goes through the injected `fetch` (tests pass a fake;
// nothing here opens a socket by itself) and carries its own timeout.
// A registry that needs a token answers 401 with a `WWW-Authenticate:
// Bearer realm=…` header; the client asks that realm for an anonymous
// pull token once per repository and retries.

/** An image name split into the registry that serves it and the repository path. */
export interface ImageRef {
  /** API host, e.g. `registry-1.docker.io`, `ghcr.io`, `quay.io`. */
  host: string
  /** Repository path, e.g. `library/nginx`, `twin/gatus`. */
  repository: string
}

const DOCKER_HUB_HOST = "registry-1.docker.io"
const DOCKER_HUB_ALIASES = new Set(["docker.io", "index.docker.io", DOCKER_HUB_HOST])
const OTHER_HOSTS = new Set(["ghcr.io", "quay.io"])
const REPOSITORY = /^[a-z0-9]+(?:[._-]+[a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-]+[a-z0-9]+)*)*$/

/**
 * Split an image name (without tag) the way Docker does: a first segment
 * with a dot or a colon, or `localhost`, is a registry host; otherwise
 * the image lives on Docker Hub, under `library/` when it has no owner.
 * Returns null for a registry other than Docker Hub, GHCR and Quay.
 */
export function parseImageRef(image: string): ImageRef | null {
  const slash = image.indexOf("/")
  const first = slash === -1 ? "" : image.slice(0, slash)
  const hasHost = first.includes(".") || first.includes(":") || first === "localhost"
  const rest = hasHost ? image.slice(slash + 1) : image
  if (!REPOSITORY.test(rest)) return null
  if (!hasHost || DOCKER_HUB_ALIASES.has(first)) {
    return { host: DOCKER_HUB_HOST, repository: rest.includes("/") ? rest : `library/${rest}` }
  }
  return OTHER_HOSTS.has(first) ? { host: first, repository: rest } : null
}

/** The registry's own web page for an image: where a person looks for tags and notes. */
export function registryPageUrl(ref: ImageRef): string {
  if (ref.host === DOCKER_HUB_HOST) {
    return ref.repository.startsWith("library/")
      ? `https://hub.docker.com/_/${ref.repository.slice("library/".length)}`
      : `https://hub.docker.com/r/${ref.repository}`
  }
  if (ref.host === "quay.io") return `https://quay.io/repository/${ref.repository}`
  return `https://${ref.host}/${ref.repository}`
}

/** A registry request that failed: unreachable, timed out, rate-limited or refused. */
export class RegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RegistryError"
  }
}

export interface RegistryClientOptions {
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch
  /** Per-request timeout. */
  timeoutMs?: number
}

export interface RegistryClient {
  /** The digest (`sha256:…`) the registry serves for `tag` right now. */
  digest(ref: ImageRef, tag: string): Promise<string>
  /** Every tag of the repository. */
  tags(ref: ImageRef): Promise<string[]>
  /** The image's `org.opencontainers.image.source` label, when it has one and it is a web link. */
  sourceUrl(ref: ImageRef, reference: string): Promise<string | undefined>
}

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ")

const DIGEST = /^sha256:[0-9a-f]{64}$/
/** A tag as the registry spec allows it; anything else never reaches a URL. */
export const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/
const MAX_TAG_PAGES = 20

export function createRegistryClient(options: RegistryClientOptions = {}): RegistryClient {
  const fetchFn = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 10_000
  const tokens = new Map<string, string>()

  async function send(url: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      const name = error instanceof Error ? error.name : ""
      const reason = name === "TimeoutError" || name === "AbortError"
        ? `no answer within ${timeoutMs / 1000}s`
        : "registry unreachable"
      throw new RegistryError(`${reason} (${new URL(url).host})`)
    }
  }

  /** Ask the realm a 401 names for an anonymous pull token. */
  async function fetchToken(ref: ImageRef, challenge: string): Promise<string> {
    const field = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(challenge)?.[1]
    const realm = field("realm")
    if (!/^bearer /i.test(challenge) || !realm || !realm.startsWith("https://")) {
      throw new RegistryError(`${ref.host} asks for a login this client cannot do`)
    }
    const url = new URL(realm)
    const service = field("service")
    if (service) url.searchParams.set("service", service)
    url.searchParams.set("scope", `repository:${ref.repository}:pull`)
    const response = await send(url.href)
    if (!response.ok) throw new RegistryError(failure(response, url.host))
    const body = await response.json()
    const token = body?.token ?? body?.access_token
    if (typeof token !== "string" || token === "") {
      throw new RegistryError(`${url.host} returned no token`)
    }
    return token
  }

  async function request(ref: ImageRef, url: string, init: RequestInit = {}): Promise<Response> {
    const key = `${ref.host}/${ref.repository}`
    const withAuth = (): RequestInit => {
      const token = tokens.get(key)
      const headers = { ...init.headers as Record<string, string> | undefined }
      if (token) headers.Authorization = `Bearer ${token}`
      return { ...init, headers }
    }
    let response = await send(url, withAuth())
    if (response.status === 401 && !tokens.has(key)) {
      await response.body?.cancel()
      tokens.set(key, await fetchToken(ref, response.headers.get("www-authenticate") ?? ""))
      response = await send(url, withAuth())
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new RegistryError(failure(response, ref.host))
    }
    return response
  }

  const base = (ref: ImageRef) => `https://${ref.host}/v2/${ref.repository}`
  const accept = { headers: { Accept: MANIFEST_TYPES } }

  async function getJson(ref: ImageRef, path: string, init: RequestInit = {}) {
    return await (await request(ref, `${base(ref)}/${path}`, init)).json()
  }

  return {
    async digest(ref, tag) {
      if (!TAG.test(tag)) throw new RegistryError(`"${tag}" is not a valid tag`)
      const response = await request(ref, `${base(ref)}/manifests/${tag}`, {
        ...accept,
        method: "HEAD",
      })
      const digest = response.headers.get("docker-content-digest") ?? ""
      if (!DIGEST.test(digest)) throw new RegistryError(`${ref.host} returned no digest`)
      return digest
    },

    async tags(ref) {
      const all: string[] = []
      let url: string | undefined = `${base(ref)}/tags/list?n=1000`
      for (let page = 0; url && page < MAX_TAG_PAGES; page++) {
        const response = await request(ref, url)
        const body = await response.json()
        if (Array.isArray(body?.tags)) {
          all.push(...body.tags.filter((t: unknown) => typeof t === "string"))
        }
        // Next page: `Link: </v2/…?last=…&n=…>; rel="next"`. Only followed
        // on the same host, so a registry cannot send the token elsewhere.
        const next = /<([^>]+)>\s*;\s*rel="?next"?/.exec(response.headers.get("link") ?? "")?.[1]
        const nextUrl: URL | undefined = next ? new URL(next, url) : undefined
        url = nextUrl && nextUrl.host === ref.host && nextUrl.protocol === "https:"
          ? nextUrl.href
          : undefined
      }
      return all
    },

    async sourceUrl(ref, reference) {
      if (!TAG.test(reference) && !DIGEST.test(reference)) return undefined
      try {
        let manifest = await getJson(ref, `manifests/${reference}`, accept)
        if (Array.isArray(manifest?.manifests)) {
          // A multi-platform image: read the labels of one real platform.
          const entries: { digest?: string; platform?: { os?: string; architecture?: string } }[] =
            manifest.manifests
          const pick = entries.find((m) =>
            m.platform?.os === "linux" && m.platform?.architecture === "amd64"
          ) ?? entries.find((m) =>
            m.platform?.os !== "unknown"
          )
          if (!pick?.digest || !DIGEST.test(pick.digest)) return undefined
          manifest = await getJson(ref, `manifests/${pick.digest}`, accept)
        }
        const configDigest = manifest?.config?.digest
        if (typeof configDigest !== "string" || !DIGEST.test(configDigest)) return undefined
        const config = await getJson(ref, `blobs/${configDigest}`)
        const source = config?.config?.Labels?.["org.opencontainers.image.source"]
        if (typeof source !== "string") return undefined
        const url = new URL(source)
        return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined
      } catch {
        return undefined
      }
    },
  }
}

function failure(response: Response, host: string): string {
  if (response.status === 429) return `rate-limited by ${host} (HTTP 429)`
  return `${host} answered HTTP ${response.status}`
}
