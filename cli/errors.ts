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
