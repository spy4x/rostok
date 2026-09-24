// Shared "re-encrypt after a .env write" helper.
//
// `cli/server-create.ts`, `cli/stack-add.ts` and `cli/stack-remove.ts`
// all write a server's `.env` and then want `.env.age` to reflect it —
// but none of them can afford to fail the whole command over it:
// encryption is optional (no key yet is a normal, expected state, not
// an error), and even once a key exists, one bad value in one file
// shouldn't undo a write that already succeeded.
//
// AGENTS.md forbids `.then`/`.catch` chaining, so this is a plain
// async/await function instead of the `encryptEnvFiles(cwd).catch(() =>
// {})` every call site used to repeat.

import { ageStatus, encryptEnvFiles } from "@spy4x/server/env-age64"

/**
 * Re-encrypt every `.env*` under `cwd` to its `.env.age` sibling,
 * without ever throwing: a caller that just wrote a `.env` file keeps
 * going either way.
 *
 * - No key yet: prints a one-time hint, doesn't warn (this is the
 *   normal state for a project that hasn't run `rostok env setup`).
 * - A key exists but the encrypt itself fails (a bad value, a
 *   permission problem, …): warns with the module's own error message
 *   — which names only a path and a line number, never a value — so
 *   the file is left in a KNOWN state (last-successfully-encrypted, not
 *   silently stale) instead of a swallowed failure nobody sees.
 */
export async function reencryptAfterWrite(cwd: string): Promise<void> {
  try {
    if (!(await ageStatus(cwd)).keyPresent) {
      console.info("rostok: no encryption key yet — run `rostok env setup` to enable it.")
      return
    }
    await encryptEnvFiles(cwd)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(
      `rostok: .env.age NOT updated: ${message}. fix it, then run \`rostok env encrypt\``,
    )
  }
}
