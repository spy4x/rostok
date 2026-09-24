// Expected failures the user can fix: bad input, a missing file, an
// unknown stack, a failed deploy. The CLI entry prints these as one
// `rostok: <message>` line without a stack trace (see #211). Anything
// that is not a UserError is a bug and keeps its trace.

/** An error caused by the user's input or environment, not by a bug in rostok. */
export class UserError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UserError"
  }
}

/**
 * The "server not found" message shared by every call site that checks
 * for `servers/<server>/.env` before doing anything else: `stack add`
 * (stack-add.ts), `stack remove` (stack-remove.ts), and `rostok deploy`
 * (commands/deploy.ts). `cli/deploy/run-deploy.ts:108` has its own
 * identical copy of this exact string — that file belongs to a
 * different owner in this codebase's file layout, so it isn't wired to
 * call this helper, but its wording must stay byte-identical: a test in
 * cli/+main.test.ts asserts the exact string from the CLI entry point.
 */
export function serverNotFoundMessage(server: string, envPath: string): string {
  return `server '${server}' not found at ${envPath}. Run \`rostok server create ${server}\` first.`
}
