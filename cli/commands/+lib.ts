// Shared helpers for command stubs in cli/commands/.

/**
 * Stub action for subcommands not yet implemented. Prints to stderr and
 * exits 1 so the user gets a clear "coming in <phase>" pointer.
 *
 * `Deno.exit` instead of `throw` because:
 * - cleaner stderr output (no stack trace from a stub)
 * - these stubs are throwaway — Phase 5/6/7 REPLACES the action bodies
 *   rather than importing them, so the "import-time footgun" is not real.
 *
 * Returns `() => void` (not `() => never`) so cliffy's contextual type
 * inference for chained .command().action() resolves cleanly.
 */
export function notImplemented(commandName: string, phase: string): () => void {
  return () => {
    console.error(`${commandName}: coming in ${phase}. see docs/v1-cli.md.`)
    Deno.exit(1)
  }
}
