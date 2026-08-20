# rostok v2 — static website (draft)

**Status:** draft. Not ready for implementation.

## Purpose

A public-facing website that promotes `rostok` and serves as
discoverable documentation.

Single source of truth: `README.md` + `docs/*.md` in this repo. The
site is a renderer; no copy-paste between repo and site code.

## Why

- GitHub README is enough for first contact but not for discovery
  (SEO, social previews, browsable command reference).
- A site gives `rostok.dev`-style presentation without bolting a CMS
  onto the repo.
- All content stays in the repo, reviewed via PRs, versioned with the
  tool.

## When (gating conditions)

Before starting:

1. CLI v1 stable on JSR for at least one release cycle.
2. README + `docs/design/v1-cli.md` are insufficient for the audience.
3. At least one external contributor lands a PR using only the
   existing docs (proof that docs-as-source can support new users).

If any condition is false, defer.

## Status check

Do not start work on this until v1 ships and the gating conditions are
met. Revisit then.