import type { BackupPath } from "./types.ts"

export async function checkDeletedRepos(
  backupPaths: BackupPath[],
  mountPoint: string,
): Promise<boolean> {
  for (const backupPath of backupPaths) {
    const expanded = backupPath.source.replace(/^~/, Deno.env.get("HOME") || "~")
    const targetDir = `${mountPoint}/${backupPath.target}`

    try {
      const localRepos = new Set<string>()
      for await (const entry of Deno.readDir(expanded)) {
        if (entry.isDirectory) {
          localRepos.add(entry.name)
        }
      }

      const driveRepos: string[] = []
      for await (const entry of Deno.readDir(targetDir)) {
        if (entry.isDirectory && !localRepos.has(entry.name)) {
          driveRepos.push(entry.name)
        }
      }

      if (driveRepos.length > 0) {
        console.log(
          `\n⚠️  WARNING: In ${backupPath.target}, the following repositories exist on the drive but not locally:`,
        )
        console.log("   They will be DELETED from the drive:\n")
        driveRepos.forEach((repo) => console.log(`     - ${repo}`))

        const confirm = prompt("\n❓ Continue and delete these repositories? (yes/no) [yes]: ") ||
          "yes"
        if (confirm?.toLowerCase() !== "yes") {
          return false
        }
      }
    } catch (error) {
      console.warn(`⚠️  Could not check for deleted repos in ${backupPath.target}: ${error}`)
    }
  }

  return true
}

export async function syncBackups(
  backupPaths: BackupPath[],
  mountPoint: string,
): Promise<void> {
  console.log(`\n🔄 Syncing ${backupPaths.length} backup path(s)...`)

  for (const backupPath of backupPaths) {
    const expanded = backupPath.source.replace(/^~/, Deno.env.get("HOME") || "~")
    const source = `${expanded}/`
    const target = `${mountPoint}/${backupPath.target}/`

    console.log(`\n  📦 ${backupPath.source} → ${backupPath.target}`)

    const proc = new Deno.Command("rsync", {
      args: [
        "-avh",
        "--info=progress2",
        "--delete",
        "--exclude=.sync*",
        "--exclude=*.tmp",
        "--exclude=.stfolder",
        source,
        target,
      ],
      stdout: "piped",
      stderr: "piped",
    })

    const child = proc.spawn()
    const decoder = new TextDecoder()
    let lastProgress = 0

    const reader = child.stdout.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const text = decoder.decode(value)
        const lines = text.split("\n")

        for (const line of lines) {
          const match = line.match(/(\d+)%/)
          if (match) {
            const progress = parseInt(match[1])
            if (progress >= lastProgress + 5) {
              const sizeMatch = line.match(/([\d.]+[KMGT]?)/)
              const speedMatch = line.match(/([\d.]+[KMGT]?B\/s)/)
              let msg = `     Progress: ${progress}%`
              if (sizeMatch) msg += ` (${sizeMatch[1]})`
              if (speedMatch) msg += ` @ ${speedMatch[1]}`
              console.log(msg)
              lastProgress = progress
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    const status = await child.status
    if (!status.success) {
      const errorOutput = decoder.decode(await child.stderr.arrayBuffer())
      throw new Error(`Rsync failed for ${backupPath.target}: ${errorOutput}`)
    }

    console.log(`  ✅ ${backupPath.target} sync completed`)
  }

  console.log("\n✅ All syncs completed")
}
