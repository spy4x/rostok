// Shared arktype schemas for the rostok CLI.
//
// Phase 2 skeleton only ships a few placeholder types so arktype is wired
// through the dependency graph. Real schemas (StackMeta, ServerConfig, etc.)
// land in Phase 3 alongside the default resolver and secret generator.

import { type } from "arktype"

// Minimal sanity check: arktype imports cleanly and `type` produces a Type.
const _arktypeOk = type("string")
export const placeholderSchema = type("string")
