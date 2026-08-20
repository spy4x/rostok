// Shared arktype schemas for the rostok CLI.
//
// Phase 2 skeleton only ships a placeholder so the arktype import path is
// exercised at module load. Real schemas (StackMeta, ServerConfig, etc.) land
// in Phase 3 alongside the default resolver and secret generator.

import { type } from "arktype"

// Wiring smoke test: importing `type` and constructing a Type proves the
// dependency graph resolves. Phase 3 replaces this with StackMeta etc.
export const _arktypeOk = type("string")
