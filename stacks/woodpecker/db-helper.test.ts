// Tests for the woodpecker-db helper: log migration, restore and the backup copy.

import { assertEquals } from "@std/assert"
import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"
import { dataPaths, type MigrateResult, toLogLine } from "./db-helper.ts"

const LOG_TABLE = "CREATE TABLE log_entries (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, " +
  "step_id INTEGER NULL, time INTEGER NULL, line INTEGER NULL, data BLOB NULL, " +
  "created INTEGER NULL, type INTEGER NULL)"

/** A data folder with a database holding `log_entries`; the rows are `[step, line, text]`. */
async function dataDirWith(rows: [number | null, number, string][]): Promise<string> {
  const dir = await Deno.makeTempDir()
  const db = new DatabaseSync(join(dir, "woodpecker.sqlite"))
  db.exec(LOG_TABLE)
  db.exec("CREATE TABLE steps (id INTEGER PRIMARY KEY, name TEXT)")
  db.exec("INSERT INTO steps VALUES (1, 'build')")
  const insert = db.prepare(
    "INSERT INTO log_entries (step_id, time, line, data, created, type) VALUES (?, ?, ?, ?, 0, 0)",
  )
  for (const [step, line, text] of rows) {
    insert.run(step, line * 10, line, new TextEncoder().encode(text))
  }
  db.close()
  return dir
}

/** The `data` of each line in a step's log file, decoded. */
async function logTexts(dir: string, step: number): Promise<string[]> {
  const text = await Deno.readTextFile(join(dir, "logs", `${step}.json`))
  return text.trimEnd().split("\n").map((line) =>
    new TextDecoder().decode(Uint8Array.fromBase64(JSON.parse(line).data))
  )
}

/**
 * Calls one of the helper's exported functions in a child `deno eval`, which has every
 * permission. Deno's node:sqlite allows SQLite's ATTACH, which VACUUM needs, only to a process
 * with every permission; the helper's container runs it with `-A`, the test task does not.
 */
async function callHelper<T>(name: string, ...args: unknown[]): Promise<T> {
  const helper = new URL("./db-helper.ts", import.meta.url).href
  const code = `const h = await import(${JSON.stringify(helper)}); ` +
    `console.log(JSON.stringify(h[${JSON.stringify(name)}](...${JSON.stringify(args)})))`
  const { code: exit, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["eval", code],
  }).output()
  if (exit !== 0) throw new Error(new TextDecoder().decode(stderr))
  return JSON.parse(new TextDecoder().decode(stdout))
}

const migrateLogs = (database: string, logs: string) =>
  callHelper<MigrateResult>("migrateLogs", database, logs)
const snapshot = (database: string, backup: string) =>
  callHelper<boolean>("snapshot", database, backup)
const restoreIfMissing = (paths: ReturnType<typeof dataPaths>) =>
  callHelper<boolean>("restoreIfMissing", paths)

function count(database: string, sql: string): number {
  const db = new DatabaseSync(database)
  try {
    return Number((db.prepare(sql).get() as { n: number }).n)
  } finally {
    db.close()
  }
}

Deno.test("woodpecker-db: a log line has the JSON shape the Go server writes", () => {
  const line = toLogLine({
    id: 7,
    step_id: 3,
    time: 12,
    line: 4,
    data: new TextEncoder().encode("hi\n"),
    type: 1,
  })
  assertEquals(line, `{"id":7,"step_id":3,"time":12,"line":4,"data":"aGkK","type":1}`)
  assertEquals(
    toLogLine({ id: 1, step_id: 2, time: null, line: null, data: null, type: null }),
    `{"id":1,"step_id":2,"time":0,"line":0,"data":null,"type":0}`,
  )
})

Deno.test("woodpecker-db: moves each step's log to its own file in line order", async () => {
  const dir = await dataDirWith([[2, 1, "b1"], [1, 1, "a1"], [2, 0, "b0"], [1, 0, "a0"]])
  try {
    const paths = dataPaths(dir)
    assertEquals(await migrateLogs(paths.database, paths.logs), { steps: 2, lines: 4, skipped: 0 })
    assertEquals(await logTexts(dir, 1), ["a0", "a1"])
    assertEquals(await logTexts(dir, 2), ["b0", "b1"])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("woodpecker-db: keeps the first copy of a line a step has twice", async () => {
  const dir = await dataDirWith([[1, 0, "first"], [1, 1, "next"], [1, 0, "second run"]])
  try {
    const paths = dataPaths(dir)
    assertEquals(await migrateLogs(paths.database, paths.logs), { steps: 1, lines: 2, skipped: 1 })
    assertEquals(await logTexts(dir, 1), ["first", "next"])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("woodpecker-db: skips rows that belong to no step", async () => {
  const dir = await dataDirWith([[null, 0, "lost"], [1, 0, "kept"]])
  try {
    const paths = dataPaths(dir)
    assertEquals(await migrateLogs(paths.database, paths.logs), { steps: 1, lines: 1, skipped: 1 })
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("woodpecker-db: empties the log table and keeps every other table", async () => {
  const dir = await dataDirWith([[1, 0, "x".repeat(10_000)]])
  try {
    const paths = dataPaths(dir)
    await migrateLogs(paths.database, paths.logs)
    assertEquals(count(paths.database, "SELECT count(*) AS n FROM log_entries"), 0)
    assertEquals(count(paths.database, "SELECT count(*) AS n FROM steps"), 1)
    // A second run finds nothing to move and leaves the files alone.
    assertEquals(await migrateLogs(paths.database, paths.logs), { steps: 0, lines: 0, skipped: 0 })
    assertEquals((await logTexts(dir, 1))[0].length, 10_000)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("woodpecker-db: does nothing before the server has created its database", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const paths = dataPaths(dir)
    assertEquals(await migrateLogs(paths.database, paths.logs), { steps: 0, lines: 0, skipped: 0 })
    assertEquals(await snapshot(paths.database, paths.backup), false)
    // Neither call may create the database: the server would then find an empty file.
    assertEquals(await Array.fromAsync(Deno.readDir(dir)), [])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("woodpecker-db: the backup copy is a readable database", async () => {
  const dir = await dataDirWith([[1, 0, "a"]])
  try {
    const paths = dataPaths(dir)
    assertEquals(await snapshot(paths.database, paths.backup), true)
    assertEquals(count(paths.backup, "SELECT count(*) AS n FROM steps"), 1)
    assertEquals(
      (await Array.fromAsync(Deno.readDir(join(dir, "backup")))).map((entry) => entry.name),
      ["woodpecker.sqlite"],
    )
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("woodpecker-db: restores the database from the backup copy only when it is missing", async () => {
  const dir = await dataDirWith([[1, 0, "a"]])
  try {
    const paths = dataPaths(dir)
    await snapshot(paths.database, paths.backup)
    assertEquals(await restoreIfMissing(paths), false)

    await Deno.remove(paths.database)
    assertEquals(await restoreIfMissing(paths), true)
    assertEquals(count(paths.database, "SELECT count(*) AS n FROM steps"), 1)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})
