// Re-encryption wrapper.
//
// Per docs/v1-cli.md §6, every `.env` mutation triggers re-encryption of
// the corresponding `.env.age`. The actual encryption logic lives in
// `scripts/encryption/encrypt.ts` (existing age64 flow). This module shells
// out to `deno task env:encrypt` after each write so `.env.age` stays in
// sync with `.env`.
//
// Failures are non-fatal (warn) — encryption hiccups shouldn't block the
// wizard. Phase 5 ships this; Phase 6 will tighten error reporting.

export interface EncryptResult {
  ok: boolean
  /** Captured stdout+stderr from the encrypt task. */
  output: string
}

/**
 * Run `deno task env:encrypt` in `cwd`. Returns ok=true on exit code 0;
 * ok=false with the captured output on any failure.
 *
 * Caller is responsible for `cwd` — pass the project root that contains
 * the `.env` / `.env.age` files to re-encrypt.
 */
export async function encryptEnvFiles(cwd: string): Promise<EncryptResult> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["task", "env:encrypt"],
    cwd,
    stdout: "piped",
    stderr: "piped",
  })
  const out = await cmd.output()
  const output = new TextDecoder().decode(
    new Uint8Array([...out.stdout, ...out.stderr]),
  )
  if (out.success) return { ok: true, output }
  // Non-fatal: warn, don't throw. The .env file is still written.
  console.warn(`env:encrypt failed (cwd=${cwd}):`)
  console.warn(output)
  return { ok: false, output }
}
