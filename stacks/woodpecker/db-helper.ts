// db-helper.ts — runs in the `woodpecker-db` service, next to the Woodpecker server.
//
// Three jobs, all on the server's data folder (/var/lib/woodpecker):
//
// 1. Restore. When `woodpecker.sqlite` is missing and a copy exists in `backup/`, put the copy in
//    place. A restore from the nightly backup brings back only `backup/` and `logs/`, so this is
//    what turns it into a working server again.
// 2. Move logs. Woodpecker used to keep build logs in the database (`log_entries`), which made it
//    grow by gigabytes. The server now writes one file per step to `logs/<step id>.json`. This
//    writes every log still in the database to that file format, then empties the table and
//    shrinks the file. It runs before the server starts (compose waits for this service's health
//    check), so nothing writes to the database meanwhile.
// 3. Copy. Every 15 minutes, `VACUUM INTO` writes a consistent, compact copy of the live database
//    to `backup/woodpecker.sqlite`. The nightly backup saves that copy and `logs/` without
//    stopping anything, so pipelines keep running through it.
//
// Uses only `node:` built-ins: the container has no network, and the script needs no cache.

import { DatabaseSync } from "node:sqlite"
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"

/** Minutes between two copies of the live database. */
const SNAPSHOT_MINUTES = 15

/** The health check looks for this file; it exists once the server may start. */
const READY_FILE = "/tmp/woodpecker-db-ready"

/** Where each file lives inside the server's data folder. */
export interface DataPaths {
  database: string
  logs: string
  backup: string
}

/** The paths of the server's data folder `dataDir`. */
export function dataPaths(dataDir: string): DataPaths {
  return {
    database: join(dataDir, "woodpecker.sqlite"),
    logs: join(dataDir, "logs"),
    backup: join(dataDir, "backup", "woodpecker.sqlite"),
  }
}

/**
 * Copies the backup into place when the live database is missing. Returns true when it did.
 * An existing database is never replaced: to restore over one, delete it first.
 */
export function restoreIfMissing(paths: DataPaths): boolean {
  if (existsSync(paths.database) || !existsSync(paths.backup)) return false
  const partial = `${paths.database}.restoring`
  copyFileSync(paths.backup, partial)
  renameSync(partial, paths.database)
  return true
}

/** One row of `log_entries`, as `node:sqlite` returns it. */
interface LogRow {
  id: number
  step_id: number | null
  time: number | null
  line: number | null
  data: Uint8Array | null
  type: number | null
}

/**
 * One line of a Woodpecker log file: the JSON that the server's Go code writes for a
 * `model.LogEntry`, with `data` in base64 as Go encodes a byte slice.
 */
export function toLogLine(row: LogRow): string {
  return JSON.stringify({
    id: row.id,
    step_id: row.step_id ?? 0,
    time: row.time ?? 0,
    line: row.line ?? 0,
    data: row.data ? row.data.toBase64() : null,
    type: row.type ?? 0,
  })
}

/** What `migrateLogs` did. */
export interface MigrateResult {
  steps: number
  lines: number
  /** Rows left out: a second copy of a line a step already has, or a row with no step. */
  skipped: number
}

/**
 * Writes every row of `log_entries` to `<logs>/<step id>.json`, one line per log line in line
 * order, then deletes the rows and shrinks the database file. A step's file is written to a
 * temporary name first, so a crash leaves either the old file or the whole new one; the rows are
 * deleted only after every file is written, so a rerun redoes the work. When a step has the same
 * line twice (a workflow that ran twice), the first copy is kept, as Woodpecker 3.18 does when it
 * deduplicates its own table.
 */
export function migrateLogs(database: string, logs: string): MigrateResult {
  const result: MigrateResult = { steps: 0, lines: 0, skipped: 0 }
  if (!existsSync(database)) return result
  const db = new DatabaseSync(database)
  try {
    db.exec("PRAGMA busy_timeout = 30000")
    const table = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'log_entries'",
    ).get()
    if (!table) return result
    if (!db.prepare("SELECT 1 FROM log_entries LIMIT 1").get()) return result

    mkdirSync(logs, { recursive: true })
    let stepId: number | null = null
    let byLine = new Map<number, LogRow>()
    const flush = () => {
      if (stepId === null) return
      const rows = [...byLine.values()].sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
      const file = join(logs, `${stepId}.json`)
      writeFileSync(`${file}.migrating`, rows.map((row) => `${toLogLine(row)}\n`).join(""), {
        mode: 0o600,
      })
      renameSync(`${file}.migrating`, file)
      result.steps++
      result.lines += rows.length
    }

    const rows = db.prepare(
      "SELECT id, step_id, time, line, data, type FROM log_entries ORDER BY step_id, id",
    ).iterate() as Iterable<LogRow>
    for (const row of rows) {
      if (row.step_id === null) {
        result.skipped++
        continue
      }
      if (row.step_id !== stepId) {
        flush()
        stepId = row.step_id
        byLine = new Map()
      }
      const line = row.line ?? 0
      if (byLine.has(line)) result.skipped++
      else byLine.set(line, row)
    }
    flush()
  } finally {
    db.close()
  }

  // Each on its own connection: in Deno's node:sqlite, a VACUUM that follows another statement
  // on the same connection fails with "too many attached databases - max 0".
  execAlone(database, "DELETE FROM log_entries")
  execAlone(database, "VACUUM")
  return result
}

/** Runs one SQL statement on a connection of its own. */
function execAlone(database: string, sql: string) {
  const db = new DatabaseSync(database)
  try {
    db.exec(sql)
  } finally {
    db.close()
  }
}

/**
 * Writes a consistent, compact copy of the live database to `backup`, through a temporary file
 * so the backup never sees half a copy. Does nothing while the server has not created its
 * database yet.
 */
export function snapshot(database: string, backup: string): boolean {
  if (!existsSync(database)) return false
  mkdirSync(join(backup, ".."), { recursive: true })
  const partial = `${backup}.partial`
  rmSync(partial, { force: true })
  // No busy timeout: it is a statement too, and VACUUM INTO must be the connection's first (see
  // execAlone). VACUUM INTO only reads, and readers never wait for a writer in WAL mode.
  const db = new DatabaseSync(database)
  try {
    db.prepare("VACUUM INTO ?").run(partial)
  } finally {
    db.close()
  }
  renameSync(partial, backup)
  return true
}

function log(message: string) {
  console.log(`${new Date().toISOString()} ${message}`)
}

if (import.meta.main) {
  process.on("SIGTERM", () => process.exit(0))
  const paths = dataPaths("/var/lib/woodpecker")
  rmSync(READY_FILE, { force: true })

  if (restoreIfMissing(paths)) log(`restored ${paths.database} from ${paths.backup}`)
  const moved = migrateLogs(paths.database, paths.logs)
  if (moved.steps > 0 || moved.skipped > 0) {
    log(
      `moved ${moved.lines} log lines of ${moved.steps} steps to ${paths.logs}; ` +
        `left out ${moved.skipped} duplicate or orphan rows`,
    )
  }

  // Exits non-zero on a failed copy, so Docker restarts the service and the restart count shows
  // that the backup copy is going stale.
  while (true) {
    if (snapshot(paths.database, paths.backup)) log(`copied the database to ${paths.backup}`)
    writeFileSync(READY_FILE, "")
    await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_MINUTES * 60_000))
  }
}
