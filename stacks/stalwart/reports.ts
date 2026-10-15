// reports.ts — keep Stalwart from mailing reports to other domains.
//
// Stalwart's defaults send a daily DMARC aggregate report and a TLS report to every domain that
// mailed this server, plus DMARC, DKIM and SPF failure reports. For a personal mail server that is
// outbound mail nobody asked for: it tells third parties who wrote to you, and a sender whose
// report address is dead (a Google Group that rejects outsiders, say) bounces it back to
// postmaster every day. Reports that other servers send to us still arrive; only sending stops.

import { STALWART_ACCOUNT } from "./dkim.ts"
import type { JmapCall, JmapResponse } from "./dkim.ts"

/** A Stalwart expression with no conditions: always `value`. */
interface ConstantExpression {
  match: Record<string, never>
  else: string
}

/** Settings object, field and the value that turns its sending off. */
interface ReportSwitch {
  object: string
  field: string
  off: string
}

/**
 * Every outbound report switch. Aggregate reports take a schedule (`disable` turns them off);
 * failure reports take a rate limit (`false` turns them off).
 */
export const REPORT_SWITCHES: ReportSwitch[] = [
  { object: "DmarcReportSettings", field: "aggregateSendFrequency", off: "disable" },
  { object: "DmarcReportSettings", field: "failureSendFrequency", off: "false" },
  { object: "TlsReportSettings", field: "sendFrequency", off: "disable" },
  { object: "DkimReportSettings", field: "sendFrequency", off: "false" },
  { object: "SpfReportSettings", field: "sendFrequency", off: "false" },
]

/**
 * The updates that turn every outbound report off, by settings object, given each object's
 * current singleton. A field already off is left out; an object with nothing to change is
 * absent. Exported for tests — no I/O.
 */
export function planReportUpdates(
  current: Record<string, Record<string, unknown> | undefined>,
): Record<string, Record<string, ConstantExpression>> {
  const plan: Record<string, Record<string, ConstantExpression>> = {}
  for (const { object, field, off } of REPORT_SWITCHES) {
    const value = current[object]?.[field] as Partial<ConstantExpression> | undefined
    const isOff = value?.else === off && Object.keys(value.match ?? {}).length === 0
    if (isOff) continue
    plan[object] = { ...plan[object], [field]: { match: {}, else: off } }
  }
  return plan
}

/**
 * Turn off every report Stalwart would send to other domains. Returns the number of settings
 * changed; 0 when all were already off.
 */
export async function ensureNoOutboundReports(
  jmap: (calls: JmapCall) => Promise<JmapResponse>,
): Promise<number> {
  const objects = [...new Set(REPORT_SWITCHES.map((s) => s.object))]
  const got = await jmap({
    using: ["urn:ietf:params:jmap:core"],
    methodCalls: objects.map((object, i) => [
      `x:${object}/get`,
      { accountId: STALWART_ACCOUNT, ids: ["singleton"] },
      String(i),
    ]),
  })
  const current: Record<string, Record<string, unknown> | undefined> = {}
  for (const [method, result] of got.methodResponses) {
    const object = method.replace(/^x:/, "").replace(/\/get$/, "")
    current[object] = (result as { list?: Record<string, unknown>[] }).list?.[0]
  }
  const plan = planReportUpdates(current)
  const entries = Object.entries(plan)
  if (entries.length === 0) return 0

  const set = await jmap({
    using: ["urn:ietf:params:jmap:core"],
    methodCalls: entries.map(([object, update], i) => [
      `x:${object}/set`,
      { accountId: STALWART_ACCOUNT, update: { singleton: update } },
      String(i),
    ]),
  })
  for (const [method, result] of set.methodResponses) {
    const notUpdated = (result as { notUpdated?: Record<string, unknown> }).notUpdated
    if (notUpdated && Object.keys(notUpdated).length > 0) {
      throw new Error(`${method} refused: ${JSON.stringify(notUpdated)}`)
    }
  }
  return entries.reduce((n, [, update]) => n + Object.keys(update).length, 0)
}
