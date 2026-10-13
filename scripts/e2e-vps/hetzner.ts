/**
 * The part of the Hetzner Cloud API the real-server test needs, over plain `fetch`.
 *
 * Every function takes the `fetch` to use, so the unit tests never touch the network. The one
 * rule this module exists to hold: it deletes only servers and SSH keys that carry the label
 * {@link LABEL}. The list query selects by that label, {@link listLabelled} drops whatever comes
 * back without it, and {@link deleteOne}, the only function that sends a DELETE, checks it again.
 *
 * @module
 */

/** Label key every server and SSH key of the test carries; its value is the run id. */
export const LABEL = "rostok-e2e"

/** A labelled server older than this belongs to a run that was killed before its cleanup. */
export const STALE_MS = 2 * 60 * 60 * 1000

const API = "https://api.hetzner.cloud/v1"
const REQUEST_TIMEOUT_MS = 30_000

/** The two kinds of object the test creates, named as the API paths name them. */
export type Kind = "servers" | "ssh_keys"

/** What the cleanup needs to know about a server or an SSH key. */
export interface Labelled {
  id: number
  name: string
  created: string
  labels?: Record<string, string>
}

/** A server as far as the test reads it. */
export interface Server extends Labelled {
  status: string
  public_net?: { ipv4?: { ip?: string } | null }
}

/** One authenticated API call: resolves with the parsed body, rejects on a non-2xx status. */
// deno-lint-ignore no-explicit-any
export type Call = (method: string, path: string, body?: unknown) => Promise<any>

/**
 * Reads the API token from the environment.
 *
 * @param get Reads one environment variable.
 * @throws When `HETZNER_CLOUD_API_TOKEN` is missing or empty.
 */
export function tokenFromEnv(get: (key: string) => string | undefined): string {
  const token = get("HETZNER_CLOUD_API_TOKEN")?.trim()
  if (!token) {
    throw new Error(
      "HETZNER_CLOUD_API_TOKEN is not set. Load it for this one command, for example:\n" +
        "  T=\"$(sed -n 's/^HETZNER_CLOUD_API_TOKEN=//p' <env file>)\" && " +
        'HETZNER_CLOUD_API_TOKEN="$T" deno task e2e:vps local',
    )
  }
  return token
}

/**
 * Builds the authenticated caller. The token travels only in the `Authorization` header: never
 * in the URL, the body or an error message.
 */
export function createCall(token: string, fetchFn: typeof fetch): Call {
  return async (method, path, body) => {
    const res = await fetchFn(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await res.text()
    // deno-lint-ignore no-explicit-any
    let json: any = {}
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      // A non-JSON body (a proxy error page) is reported by its status alone.
    }
    if (!res.ok) {
      const code = json?.error?.code ?? "unknown"
      const message = json?.error?.message ?? ""
      throw new Error(`Hetzner API ${method} ${path}: ${res.status} ${code} ${message}`.trim())
    }
    return json
  }
}

/** True when the object carries the test's label, whatever its value. */
export function hasLabel(o: Labelled): boolean {
  return o.labels !== undefined && Object.hasOwn(o.labels, LABEL)
}

/** Matches the objects of one run. */
export function ofRun(runId: string): (o: Labelled) => boolean {
  return (o) => o.labels?.[LABEL] === runId
}

/** Matches objects created more than {@link STALE_MS} before `now`. */
export function olderThanStale(now: number): (o: Labelled) => boolean {
  return (o) => now - Date.parse(o.created) > STALE_MS
}

/**
 * Lists every server or SSH key that carries the label, following pagination. The query asks the
 * API for the label, and the result is filtered again, so an object without it never leaves this
 * function even if the API ignored the selector.
 */
export async function listLabelled(call: Call, kind: Kind): Promise<Labelled[]> {
  const found: Labelled[] = []
  for (let page: number | null = 1; page !== null;) {
    const json = await call("GET", `/${kind}?label_selector=${LABEL}&per_page=50&page=${page}`)
    found.push(...(json[kind] as Labelled[]).filter(hasLabel))
    page = json.meta?.pagination?.next_page ?? null
  }
  return found
}

/**
 * Deletes one server or SSH key. The only place a DELETE is sent.
 *
 * @throws Before any request when the object does not carry the label.
 */
export async function deleteOne(call: Call, kind: Kind, o: Labelled): Promise<void> {
  if (!hasLabel(o)) {
    throw new Error(`refusing to delete ${kind} "${o.name}": it has no ${LABEL} label`)
  }
  await call("DELETE", `/${kind}/${o.id}`)
}

/**
 * Deletes the labelled objects of one kind that `match` accepts.
 *
 * @returns The names it deleted.
 */
export async function deleteLabelled(
  call: Call,
  kind: Kind,
  match: (o: Labelled) => boolean,
): Promise<string[]> {
  const deleted: string[] = []
  for (const o of await listLabelled(call, kind)) {
    if (!match(o)) continue
    await deleteOne(call, kind, o)
    deleted.push(o.name)
  }
  return deleted
}

/** A server type in one location, with its hourly price. */
export interface Offer {
  type: string
  location: string
  hourly: number
}

/**
 * Every x86 server type that is not deprecated, in each location that sells it, cheapest first.
 * The caller tries them in order, because the cheapest one can be out of stock.
 */
export async function cheapestX86(call: Call): Promise<Offer[]> {
  const json = await call("GET", "/server_types?per_page=50")
  const offers: Offer[] = []
  for (const t of json.server_types) {
    if (t.architecture !== "x86" || t.deprecated === true || t.deprecation) continue
    for (const p of t.prices ?? []) {
      offers.push({ type: t.name, location: p.location, hourly: Number(p.price_hourly.net) })
    }
  }
  return offers.sort((a, b) =>
    a.hourly - b.hourly || a.type.localeCompare(b.type) || a.location.localeCompare(b.location)
  )
}

/** Registers the throwaway public key, labelled with the run id. */
export async function createKey(call: Call, runId: string, publicKey: string): Promise<number> {
  const json = await call("POST", "/ssh_keys", {
    name: `${LABEL}-${runId}`,
    public_key: publicKey,
    labels: { [LABEL]: runId },
  })
  return json.ssh_key.id
}

/** Creates the server, labelled with the run id, and returns it as the API first reports it. */
export async function createServer(
  call: Call,
  runId: string,
  offer: Offer,
  keyId: number,
  userData: string,
): Promise<Server> {
  const json = await call("POST", "/servers", {
    name: `${LABEL}-${runId}`,
    server_type: offer.type,
    location: offer.location,
    image: "ubuntu-24.04",
    ssh_keys: [keyId],
    labels: { [LABEL]: runId },
    user_data: userData,
  })
  return json.server
}
