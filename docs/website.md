# Static website (idea — v2+)

**Status:** not started. Captured for future planning.

## Goal

A public-facing website that promotes `rostok` and serves as
discoverable documentation. The whole site is generated from the
existing sources — `README.md` and `docs/*.md` — so there is **one
source of truth** and no copy-paste drift between site and repo.

## Hard constraints

- **No hardcoded copy** in site code. Every word on the site must
  trace back to a tracked `.md` file in this repo.
- **Build runs in CI.** Pushing to `main` rebuilds + deploys.
- **No editor / CMS.** Editing = open PR against the `.md` file.
- **Fast, lightweight.** Static HTML + minimal JS. No SPA shell, no
  hydration cost.
- **Accessible.** Semantic HTML, readable without JS, contrast-safe
  palette.

## Tooling candidates

Decide when we get there. Each fits the constraints:

| Tool | Pros | Cons |
|---|---|---|
| **Fresh 2** | Deno-native, islands architecture, no JS by default | Newer, smaller community |
| **Astro** | Markdown-first, content collections, mature | Brings Node toolchain |
| **Next (app router)** | Familiar, large ecosystem | Heavier than needed |

Recommendation when the time comes: **Fresh 2** if the rest of the
stack stays Deno-first; **Astro** if a contributor is more comfortable
with Node.

## Sections (mirror docs/)

- `/` — landing (rendered from `README.md`)
- `/docs/getting-started` — from `docs/cli.md` "Quickstart"
- `/docs/commands` — from `docs/cli.md` "Commands"
- `/docs/stack-schema` — from `docs/cli-design.md` §4
- `/docs/cross-stack-wiring` — from `docs/cli-design.md` §6
- `/docs/backlog` — from `docs/cli.md`
- `/changelog` — generated from git tags / commit log

## Branding

- Logo: a sprout icon. SVG, themeable (light/dark).
- Palette: green primary, neutral grey, monospace for code.
- Typography: a single readable sans (Inter / IBM Plex Sans) + a
  monospace (JetBrains Mono / IBM Plex Mono).

## Hosting

- Cloudflare Pages or GH Pages — both free for the expected traffic.
- Custom domain `rostok.dev` (or similar — TBD with naming).

## Open questions

- Do we want a blog? (Probably no — release notes via GH releases.)
- Do we want a "live demo"? (Probably no — security/operational cost.)
- Do we want comment threads? (Probably no — use GH Discussions.)

## Status check before starting

Before opening a PR for the website:

1. CLI v1 is stable and on JSR
2. At least 10 community users have adopted `rostok`
3. The marketing surface (GitHub README, JSR page) is insufficient
   for the audience we want to reach

If any of those is false, the website is premature. Revisit then.