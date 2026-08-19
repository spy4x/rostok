import { log } from "../+lib.ts"

interface RepoReport {
  name: string
  status: "healthy" | "partial" | "broken"
  goodSnapshots: number
  badSnapshots: number
  errors: string[]
}

/**
 * Recovers corrupted restic repositories.
 *
 * Strategy:
 *   - healthy: no action
 *   - partial: delete corrupted snapshot blobs + corrupted index files, run `restic repair index`
 *   - broken: re-initialize repo (data loss acknowledged; backup must run again to repopulate)
 *
 * Run: deno task backup:recover
 */
async function main() {
  const password = Deno.env.get("BACKUPS_PASSWORD")
  if (!password) throw new Error("BACKUPS_PASSWORD not set")

  const basePath = Deno.env.get("PATH_BACKUPS")?.replace("~", Deno.env.get("HOME") || "~")
  if (!basePath) throw new Error("PATH_BACKUPS not set")

  log(`Scanning ${basePath} ...`)
  const repos: RepoReport[] = []
  for await (const entry of Deno.readDir(basePath)) {
    if (!entry.isDirectory) continue
    const repoPath = `${basePath}/${entry.name}`
    const report = await checkRepo(entry.name, repoPath, password)
    repos.push(report)
  }

  log("\n========== SCAN REPORT ==========")
  for (const r of repos) {
    const icon = r.status === "healthy" ? "✅" : r.status === "partial" ? "⚠️ " : "❌"
    console.log(
      `${icon} ${r.name.padEnd(25)} ${
        r.status.padEnd(8)
      } good=${r.goodSnapshots} bad=${r.badSnapshots}`,
    )
  }

  const partial = repos.filter((r) => r.status === "partial")
  const broken = repos.filter((r) => r.status === "broken")
  log(
    `\nSummary: ${
      repos.length - partial.length - broken.length
    } healthy, ${partial.length} partial, ${broken.length} broken`,
  )

  if (Deno.args.includes("--dry-run")) {
    log("\nDry-run: would recover the above. Re-run without --dry-run to execute.")
    return
  }

  if (
    !confirm(
      `\nProceed with recovery?\n` +
        `  ${partial.length} partial repos: DELETE ALL SNAPSHOTS, keep data packs.\n` +
        `      Existing restore points are gone; the next backup starts a new one.\n` +
        `  ${broken.length} broken repos: DELETE THE REPO AND RE-INIT. ALL DATA LOST.\n` +
        `\nType 'YES' to confirm: `,
    )
  ) {
    log("Aborted.")
    return
  }

  // One repo that cannot be cleared must not strand the rest, and the final
  // check below still needs to run — so report and carry on.
  const failures: string[] = []

  log("\n========== RECOVERING PARTIAL REPOS ==========")
  for (const r of partial) {
    try {
      await recoverPartial(`${basePath}/${r.name}`, password)
    } catch (err) {
      log(`    ❌ ${r.name}: ${(err as Error).message}`)
      failures.push(r.name)
    }
  }

  log("\n========== RE-INITIALIZING BROKEN REPOS ==========")
  for (const r of broken) {
    try {
      await reinitRepo(`${basePath}/${r.name}`, password)
    } catch (err) {
      log(`    ❌ ${r.name}: ${(err as Error).message}`)
      failures.push(r.name)
    }
  }

  log("\n========== FINAL CHECK ==========")
  for (const r of repos.filter((r) => r.status !== "healthy")) {
    const final = await checkRepo(r.name, `${basePath}/${r.name}`, password)
    const icon = final.status === "healthy" ? "✅" : final.status === "partial" ? "⚠️ " : "❌"
    console.log(`${icon} ${final.name}: ${final.status}`)
  }

  if (failures.length) {
    log(`\n${failures.length} repo(s) could not be recovered: ${failures.join(", ")}`)
  }
  log("\nDone. Re-run main backup: deno task backup")
}

async function checkRepo(name: string, path: string, password: string): Promise<RepoReport> {
  const errors: string[] = []
  const cmd = new Deno.Command("restic", {
    args: ["-r", path, "snapshots"],
    env: { RESTIC_PASSWORD: password },
    stdout: "piped",
    stderr: "piped",
  })
  const { code, stdout, stderr } = await cmd.output()
  const out = new TextDecoder().decode(stdout)
  const err = new TextDecoder().decode(stderr)
  const combined = out + "\n" + err

  if (code !== 0) {
    errors.push(err.trim().split("\n")[0])
    return { name, status: "broken", goodSnapshots: 0, badSnapshots: 0, errors }
  }

  const ignoring = (combined.match(/^Ignoring/gm) || []).length
  const goodLines = combined.split("\n").filter((l) => /^[0-9a-f]{8}\s/.test(l))

  let status: RepoReport["status"] = "healthy"
  if (ignoring > 0 && goodLines.length > 0) status = "partial"
  else if (ignoring > 0 && goodLines.length === 0) status = "broken"

  return { name, status, goodSnapshots: goodLines.length, badSnapshots: ignoring, errors }
}

async function recoverPartial(path: string, password: string) {
  log(`  Repairing ${path} ...`)

  // Strategy: delete ALL snapshot blobs (corrupted ones can't be referenced by `restic forget`),
  // keep pack files (data intact), delete + rebuild index. Result: clean repo with 0 snapshots
  // but all data packs preserved. Next backup creates new snapshot — no data loss.
  for (const subdir of ["snapshots", "index", "locks"]) {
    try {
      await Deno.remove(`${path}/${subdir}`, { recursive: true })
    } catch (err) {
      // Absent is fine. Anything else (permissions, EBUSY) would leave a
      // half-cleared repo that `repair index` cannot reason about, so stop.
      if (!(err instanceof Deno.errors.NotFound)) {
        throw new Error(`could not clear ${path}/${subdir}: ${(err as Error).message}`)
      }
    }
  }

  const repairCmd = new Deno.Command("restic", {
    args: ["-r", path, "repair", "index"],
    env: { RESTIC_PASSWORD: password },
    stdout: "piped",
    stderr: "piped",
  })
  const { code, stderr } = await repairCmd.output()
  if (code !== 0) {
    log(`    ⚠️  repair index failed: ${new TextDecoder().decode(stderr).trim().split("\n")[0]}`)
  } else {
    log(`    ✅ repaired (snapshots cleared, packs preserved)`)
  }
}

async function reinitRepo(path: string, password: string) {
  log(`  Re-initializing ${path} ...`)
  // A swallowed failure here would leave a partially-deleted repo and then
  // init over it, which is worse than not trying.
  try {
    await Deno.remove(path, { recursive: true })
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw new Error(`could not remove ${path}: ${(err as Error).message}`)
    }
  }
  await Deno.mkdir(path, { recursive: true })
  const cmd = new Deno.Command("restic", {
    args: ["-r", path, "init"],
    env: { RESTIC_PASSWORD: password },
    stdout: "piped",
    stderr: "piped",
  })
  const { code, stderr } = await cmd.output()
  if (code !== 0) {
    log(`    ❌ init failed: ${new TextDecoder().decode(stderr).trim()}`)
  } else {
    log(`    ✅ re-initialized`)
  }
}

function confirm(prompt: string): boolean {
  // Read from stdin synchronously
  const buf = new Uint8Array(1024)
  Deno.stdout.write(new TextEncoder().encode(prompt))
  const n = Deno.stdin.readSync(buf)
  if (n === null) return false
  const answer = new TextDecoder().decode(buf.subarray(0, n)).trim()
  return answer === "YES"
}

if (import.meta.main) {
  await main()
}
