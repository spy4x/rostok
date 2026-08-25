// Package metadata. Single source of truth for CLI version + name.
// Version is duplicated in deno.jsonc (`version` field) — kept in
// sync manually per release.

export const VERSION = "1.0.1"

export const NAME = "rostok"
// Russian name (dropped from comments to avoid mixed-script lint friction).
export const DESCRIPTION = "Self-hosted homelab scaffolding CLI. Grow a homelab from a sprout."
