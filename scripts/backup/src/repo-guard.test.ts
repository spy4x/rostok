import { assertEquals } from "@std/assert"
import { hasNonEmptyResticSubdir } from "./repo-guard.ts"

/**
 * Fake filesystem for `hasNonEmptyResticSubdir`.
 *
 * The production helper accepts injected `statFn` and `readDirFn` so
 * we can drive it deterministically without touching the real disk
 * (or without restic installed). Only `isDirectory` is read off the
 * stat result and only the existence of any entry is read off the dir
 * listing, so the fake stays tiny.
 */
interface FsNode {
  dir?: Map<string, FsNode>
  file?: true
}

function makeFs(root: FsNode): {
  statFn: (path: string) => Promise<Deno.FileInfo | null>
  readDirFn: (path: string) => AsyncIterable<Deno.DirEntry>
} {
  const resolve = (path: string): FsNode | null => {
    if (path === "" || path === "/") return root
    const parts = path.split("/").filter(Boolean)
    let node: FsNode = root
    for (const p of parts) {
      const next = node.dir?.get(p)
      if (!next) return null
      node = next
    }
    return node
  }

  const statFn = async (path: string): Promise<Deno.FileInfo | null> => {
    const node = resolve(path)
    if (!node) return null
    // Cast: only `isDirectory` is read by the production code; the rest
    // of FileInfo is filled with safe placeholders.
    return {
      isDirectory: !!node.dir,
      isFile: !!node.file,
      isSymlink: false,
      size: 0,
      mtime: new Date(0),
      atime: new Date(0),
      birthtime: new Date(0),
      dev: 0,
      ino: 0,
      mode: 0,
      nlink: 0,
      uid: 0,
      gid: 0,
      rdev: 0,
      blksize: 0,
      blocks: 0,
      isBlockDevice: false,
      isCharDevice: false,
      isFifo: false,
      isSocket: false,
    } as Deno.FileInfo
  }

  const readDirFn = async function* (path: string): AsyncIterable<Deno.DirEntry> {
    const node = resolve(path)
    if (!node || !node.dir) return
    for (const [name, child] of node.dir) {
      yield {
        name,
        isFile: !!child.file,
        isDirectory: !!child.dir,
        isSymlink: false,
      } as Deno.DirEntry
    }
  }

  return { statFn, readDirFn }
}

const repo = (...subdirs: { name: string; children?: string[] }[]) => {
  // Wrap subdirs under a `/repo` directory so the fake matches the
  // path shape used by the production helper (`/repo`, `/repo/keys`,
  // `/repo/keys/old`). The wrapper is otherwise invisible.
  const inner: FsNode = { dir: new Map() }
  for (const s of subdirs) {
    const children: FsNode["dir"] = new Map()
    for (const c of s.children || []) children.set(c, { file: true })
    inner.dir!.set(s.name, { dir: children })
  }
  return makeFs({ dir: new Map([["repo", inner]]) })
}

Deno.test({
  // Regression for the 2026-08-05/06 incident: ensureRepository would
  // silently re-init a path that still held a keys/ from an earlier
  // incarnation, leaving an orphan key next to a brand-new config —
  // the exact state restic refuses to read.
  name: "hasNonEmptyResticSubdir detects leftover keys/ directory",
  async fn() {
    const { statFn, readDirFn } = repo({ name: "keys", children: ["old"] })
    assertEquals(await hasNonEmptyResticSubdir("/repo", statFn, readDirFn), true)
  },
})

Deno.test({
  name: "hasNonEmptyResticSubdir detects leftover data/, index/, snapshots/",
  async fn() {
    const { statFn, readDirFn } = repo(
      { name: "data", children: ["pack-1"] },
      { name: "index", children: ["idx-1"] },
      { name: "snapshots", children: ["snap-1"] },
    )
    assertEquals(await hasNonEmptyResticSubdir("/repo", statFn, readDirFn), true)
  },
})

Deno.test({
  // An empty subdirectory is not a real restic artefact — a fresh
  // re-init path might carry empty placeholder dirs from a prior
  // accident and must not trigger the guard.
  name: "hasNonEmptyResticSubdir ignores empty restic subdirs",
  async fn() {
    const { statFn, readDirFn } = repo(
      { name: "keys" },
      { name: "data" },
      { name: "index" },
      { name: "snapshots" },
    )
    assertEquals(await hasNonEmptyResticSubdir("/repo", statFn, readDirFn), false)
  },
})

Deno.test({
  name: "hasNonEmptyResticSubdir returns false for a missing path",
  async fn() {
    const { statFn, readDirFn } = makeFs({})
    assertEquals(await hasNonEmptyResticSubdir("/missing", statFn, readDirFn), false)
  },
})

Deno.test({
  name: "hasNonEmptyResticSubdir returns false when path is a regular file",
  async fn() {
    const root: FsNode = { file: true }
    const { statFn, readDirFn } = makeFs(root)
    assertEquals(await hasNonEmptyResticSubdir("/file", statFn, readDirFn), false)
  },
})

Deno.test({
  // The brand-new / never-used repo path that ensureRepository needs
  // to initialise must NOT trip the guard.
  name: "hasNonEmptyResticSubdir returns false for a brand-new empty directory",
  async fn() {
    const { statFn, readDirFn } = repo()
    assertEquals(await hasNonEmptyResticSubdir("/repo", statFn, readDirFn), false)
  },
})

Deno.test({
  // Unrelated content (a README file, a Syncthing trashcan dir, etc.)
  // must not be treated as a restic artefact.
  name: "hasNonEmptyResticSubdir ignores unrelated directories",
  async fn() {
    const fs = makeFs({
      dir: new Map([
        ["repo", {
          dir: new Map([
            // README as a file (not a directory) at the repo root.
            ["README.md", { file: true }],
            // Syncthing trashcan directory with content.
            [".stversions", { dir: new Map([["old", { file: true }]]) }],
          ]),
        }],
      ]),
    })
    assertEquals(await hasNonEmptyResticSubdir("/repo", fs.statFn, fs.readDirFn), false)
  },
})
