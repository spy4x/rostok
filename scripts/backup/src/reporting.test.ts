import { BackupReporter, ntfyConfigFromTopicUrl } from "./reporting.ts"
import {
  type BackupConfigState,
  type BackupContext,
  type BackupResult,
  BackupStatus,
} from "./types.ts"
import { assertEquals, assertMatch } from "@std/assert"

const NTFY_URL = "https://ntfy.example.com/backups"
const NTFY_TOKEN = "tk_secret123"
const HC_URL = "https://hc.example.com/ping/0192f0c4-0000-7000-8000-000000000000"

interface Call {
  url: string
  headers: Headers
}

/** A fetch stub that records every request and answers with `respond`. */
function recordingFetch(respond: (url: string) => Response) {
  const calls: Call[] = []
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    calls.push({ url, headers: new Headers(init?.headers) })
    return Promise.resolve(respond(url))
  }) as typeof fetch
  return { calls, fetcher }
}

const okFetch = () => recordingFetch(() => new Response("OK"))

function context(overrides: Partial<BackupContext> = {}): BackupContext {
  return {
    serverName: "home",
    backupsOutputBasePath: "/srv/backups",
    backupsPassword: "unused",
    ntfyUrl: NTFY_URL,
    ntfyAuth: NTFY_TOKEN,
    stacksPath: "/srv/apps/stacks",
    configsPath: "/srv/apps/configs/backup",
    healthchecksUrl: HC_URL,
    ...overrides,
  }
}

function result(failed: number): BackupResult {
  const backups = [
    { name: "db", status: BackupStatus.SUCCESS, durationMs: 1000 },
    ...Array.from({ length: failed }, (_, i) => ({
      name: `app${i}`,
      status: BackupStatus.ERROR,
      error: "restic exited 1",
      durationMs: 1000,
    })),
  ] as BackupConfigState[]
  return {
    backups,
    successCount: 1,
    totalCount: 1 + failed,
    totalSizeGB: 0,
    durationMs: 2000,
  }
}

/** Runs `fn` with console.log and console.error captured; returns everything they printed. */
async function captureLogs(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = []
  const { log, error } = console
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "))
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "))
  try {
    await fn()
  } finally {
    console.log = log
    console.error = error
  }
  return lines.join("\n")
}

const noSleep = () => Promise.resolve()

Deno.test("ntfyConfigFromTopicUrl splits NTFY_URL_BACKUPS into base URL and topic", () => {
  assertEquals(ntfyConfigFromTopicUrl(NTFY_URL, NTFY_TOKEN), {
    baseUrl: "https://ntfy.example.com",
    topic: "backups",
    token: NTFY_TOKEN,
  })
  assertEquals(ntfyConfigFromTopicUrl("https://example.com/ntfy/backups/", ""), {
    baseUrl: "https://example.com/ntfy",
    topic: "backups",
  })
})

Deno.test("ntfyConfigFromTopicUrl returns null for a value that names no topic", () => {
  assertEquals(ntfyConfigFromTopicUrl("https://ntfy.example.com/", NTFY_TOKEN), null)
  assertEquals(ntfyConfigFromTopicUrl("ntfy.example.com/backups", NTFY_TOKEN), null)
})

Deno.test("failure report posts to the same topic URL with an ASCII title, even for a non-ASCII server name", async () => {
  const { calls, fetcher } = okFetch()
  const reporter = new BackupReporter(context({ serverName: "Сервер-01" }), {
    fetcher,
    sleep: noSleep,
  })
  await captureLogs(() => reporter.sendNotification(result(1)))

  const push = calls.find((call) => !call.url.startsWith(HC_URL))!
  assertEquals(push.url, NTFY_URL)
  assertMatch(push.headers.get("Title")!, /^[\x20-\x7e]+$/)
  assertEquals(push.headers.get("Authorization"), `Bearer ${NTFY_TOKEN}`)
  assertEquals(push.headers.get("Priority"), "4")
  assertEquals(push.headers.get("Tags"), "warning")
})

Deno.test("a fully successful run pings healthchecks success and sends no ntfy push", async () => {
  const { calls, fetcher } = okFetch()
  const reporter = new BackupReporter(context(), { fetcher, sleep: noSleep })
  await captureLogs(() => reporter.sendNotification(result(0)))
  assertEquals(calls.map((call) => call.url), [HC_URL])
})

Deno.test("a run with a failed backup pings healthchecks /fail", async () => {
  const { calls, fetcher } = okFetch()
  const reporter = new BackupReporter(context(), { fetcher, sleep: noSleep })
  await captureLogs(() => reporter.sendNotification(result(1)))
  assertEquals(calls[0].url, `${HC_URL}/fail`)
})

Deno.test("the start signal pings /start and gives up after 3 attempts", async () => {
  const { calls, fetcher } = recordingFetch(() => new Response("down", { status: 503 }))
  const reporter = new BackupReporter(context(), { fetcher, sleep: noSleep })
  await captureLogs(() => reporter.sendStartSignal())
  assertEquals(calls.map((call) => call.url), [
    `${HC_URL}/start`,
    `${HC_URL}/start`,
    `${HC_URL}/start`,
  ])
})

Deno.test("pushes never log the ntfy URL, the token, the ping URL or a response body, sent or failed", async () => {
  const cases = [
    { status: 200, expected: /ntfy notification sent/ },
    { status: 500, expected: /ntfy notification failed/ },
  ]
  for (const { status, expected } of cases) {
    // healthchecks reads "OK" as accepted; ntfy ignores the body of a 2xx.
    const body = status === 200 ? "OK" : "body-with-secret"
    const { fetcher } = recordingFetch(() => new Response(body, { status }))
    const reporter = new BackupReporter(context(), { fetcher, sleep: noSleep })
    const logs = await captureLogs(async () => {
      await reporter.sendStartSignal()
      await reporter.sendNotification(result(1))
    })
    assertMatch(logs, expected)
    for (const secret of [NTFY_URL, NTFY_TOKEN, HC_URL, "body-with-secret"]) {
      assertEquals(logs.includes(secret), false, `logs contain ${secret} (status ${status})`)
    }
  }
})

Deno.test("an unusable NTFY_URL_BACKUPS is logged without its value and skipped, not thrown", async () => {
  const { calls, fetcher } = okFetch()
  const logs = await captureLogs(async () => {
    const reporter = new BackupReporter(
      context({ ntfyUrl: "ntfy.example.com/backups", healthchecksUrl: undefined }),
      { fetcher, sleep: noSleep },
    )
    await reporter.sendNotification(result(1))
  })
  assertEquals(calls, [])
  assertMatch(logs, /NTFY_URL_BACKUPS is not a topic URL/)
  assertEquals(logs.includes("ntfy.example.com/backups"), false)
})

Deno.test("an NTFY_URL_BACKUPS with a broken percent-escape is skipped, not thrown", async () => {
  const { calls, fetcher } = okFetch()
  const logs = await captureLogs(async () => {
    const reporter = new BackupReporter(
      context({ ntfyUrl: "https://ntfy.example.com/%E0%A4%A", healthchecksUrl: undefined }),
      { fetcher, sleep: noSleep },
    )
    await reporter.sendNotification(result(1))
  })
  assertEquals(calls, [])
  assertMatch(logs, /NTFY_URL_BACKUPS is not a topic URL/)
})

Deno.test("an NTFY_URL_BACKUPS with a query string is refused by name and skipped", async () => {
  const { calls, fetcher } = okFetch()
  const logs = await captureLogs(async () => {
    const reporter = new BackupReporter(
      context({ ntfyUrl: `${NTFY_URL}?auth=qs_secret`, healthchecksUrl: undefined }),
      { fetcher, sleep: noSleep },
    )
    await reporter.sendNotification(result(1))
  })
  assertEquals(calls, [])
  assertMatch(logs, /NTFY_URL_BACKUPS has a query string/)
  assertEquals(logs.includes("qs_secret"), false)
  assertEquals(ntfyConfigFromTopicUrl(`${NTFY_URL}?auth=qs_secret`, ""), null)
})

Deno.test("an unusable HEALTHCHECKS_BACKUP_URL is logged without its value and skipped, not thrown", async () => {
  const { calls, fetcher } = okFetch()
  const logs = await captureLogs(async () => {
    const reporter = new BackupReporter(context({ healthchecksUrl: "hc.example.com/ping/abc" }), {
      fetcher,
      sleep: noSleep,
    })
    await reporter.sendStartSignal()
    await reporter.sendNotification(result(0))
  })
  assertEquals(calls, [])
  assertMatch(logs, /HEALTHCHECKS_BACKUP_URL is not a valid URL/)
  assertEquals(logs.includes("hc.example.com/ping/abc"), false)
})
