// Package metadata. Single source of truth for CLI version + name.
// Bumped manually per release. Phase 3+ will read from a jsr config file
// or deno.jsonc; for now keep it trivial.

export const VERSION = "0.1.0"

export const NAME = "rostok"
// Russian name (dropped from comments to avoid mixed-script lint friction).
export const DESCRIPTION = "Self-hosted homelab scaffolding CLI. Grow a homelab from a sprout."
