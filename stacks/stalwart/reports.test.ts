import { assertEquals, assertRejects } from "@std/assert"
import { ensureNoOutboundReports, planReportUpdates } from "./reports.ts"
import type { JmapCall, JmapResponse } from "./dkim.ts"

/** Stalwart 0.16's shipped defaults, as `x:<object>/get` returns them. */
const DEFAULTS: Record<string, Record<string, unknown>> = {
  DmarcReportSettings: {
    aggregateSendFrequency: { match: {}, else: "daily" },
    failureSendFrequency: { match: {}, else: "[1, 1d]" },
  },
  TlsReportSettings: { sendFrequency: { match: {}, else: "daily" } },
  DkimReportSettings: { sendFrequency: { match: {}, else: "[1, 1d]" } },
  SpfReportSettings: { sendFrequency: { match: {}, else: "[1, 1d]" } },
}

/** A fake JMAP endpoint holding `state`, recording every call. */
function fakeServer(state: Record<string, Record<string, unknown>>, refuse = false) {
  const calls: JmapCall[] = []
  const jmap = (call: JmapCall): Promise<JmapResponse> => {
    calls.push(call)
    const methodResponses = call.methodCalls.map(([method, args, id]) => {
      const object = method.replace(/^x:/, "").replace(/\/(get|set)$/, "")
      if (method.endsWith("/get")) {
        return [method, { list: [{ ...state[object], id: "singleton" }] }, id]
      }
      const update = (args.update as Record<string, Record<string, unknown>>).singleton
      if (refuse) return [method, { notUpdated: { singleton: { type: "invalidProperties" } } }, id]
      state[object] = { ...state[object], ...update }
      return [method, { updated: { singleton: null } }, id]
    }) as JmapResponse["methodResponses"]
    return Promise.resolve({ methodResponses, sessionState: "s" })
  }
  return { jmap, calls, state }
}

Deno.test("planReportUpdates: turns every default report off", () => {
  assertEquals(planReportUpdates(DEFAULTS), {
    DmarcReportSettings: {
      aggregateSendFrequency: { match: {}, else: "disable" },
      failureSendFrequency: { match: {}, else: "false" },
    },
    TlsReportSettings: { sendFrequency: { match: {}, else: "disable" } },
    DkimReportSettings: { sendFrequency: { match: {}, else: "false" } },
    SpfReportSettings: { sendFrequency: { match: {}, else: "false" } },
  })
})

Deno.test("planReportUpdates: a conditional rule that ends in 'disable' still gets replaced", () => {
  const plan = planReportUpdates({
    ...DEFAULTS,
    TlsReportSettings: {
      sendFrequency: { match: { "0": { if: "true", then: "daily" } }, else: "disable" },
    },
  })
  assertEquals(plan.TlsReportSettings, { sendFrequency: { match: {}, else: "disable" } })
})

Deno.test("ensureNoOutboundReports: sets all five switches, then finds nothing to do", async () => {
  const server = fakeServer(structuredClone(DEFAULTS))
  assertEquals(await ensureNoOutboundReports(server.jmap), 5)
  assertEquals(planReportUpdates(server.state), {})
  const before = server.calls.length
  assertEquals(await ensureNoOutboundReports(server.jmap), 0)
  assertEquals(server.calls.length - before, 1, "a second run only reads")
})

Deno.test("ensureNoOutboundReports: throws when Stalwart refuses an update", async () => {
  const server = fakeServer(structuredClone(DEFAULTS), true)
  await assertRejects(() => ensureNoOutboundReports(server.jmap), Error, "refused")
})
