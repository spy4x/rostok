# CLI library — why @cliffy

**Decision:** `@cliffy/command@1.2.1` + `@cliffy/prompt@1.2.1` (JSR).

## Requirements

- Command parsing: subcommands, flags, args, auto help
- Interactive prompts: input, confirm, multi-select, secret
- Non-interactive mode (flags provide answers; no prompts)
- Validation hooks (custom `Type<T>` for arktype integration)
- Lightweight, well-maintained, stable v1 semver
- Not AI-slop, not low-quality, not abandoned

## Comparison (Aug 2026)

| Library | Status | Last release | Deps | Hits req? |
|---|---|---|---|---|
| **@cliffy/command** | active | 2026-05 | 6 | parsing ✓ |
| **@cliffy/prompt** | active | 2026-05 | 8 | prompts ✓ |
| @std/cli | active | 2026-06 | 2 | partial — Select/multi-select **unstable** |
| zod | active | 2026-05 | 0 | validation only |
| arktype | active | 2026-07 | 3 | validation only |
| commander | active | 2026-05 | 0 | parsing only |
| cac | active | 2026-02 | 0 | parsing only |
| inquirer | active | 2026-08 | 30+ | prompts only |
| prompts | dormant | 2023-10 | 5 | prompts only |
| enquirer | dormant | 2023-07 | 4 | prompts only |
| ink | active | 2026-07 | 25+ | React-based, overkill |
| yargs | active | 2026-07 | 9 | parsing only |

## Why cliffy

- Only mature Deno-native stack that ships parser + interactive prompts
  + validation hooks + auto help + shell completions
- Single author (c4spar), but stable since 2020 and currently 1.x-stable
- JSR-published, JSR score 88%
- Single import surface, ~14 transitive deps total

## Deno 2.x first-party check

- Deno 2.9.5 runtime — no built-in prompt/parsing APIs beyond `Deno.args`
- `jsr:@std/cli` ships `parseArgs` + `promptSecret` stable; Select,
  multi-select, spinner, progress-bar are **unstable** — not safe for a
  public CLI
- Deno 2 added `deno init` template scaffolding — runtime feature, not
  a library; doesn't substitute for prompt-driven scaffold UX

## Caveats

- Cliffy single-maintainer (c4spar). Acceptable; consistent since 2020
  and currently 1.x-stable
- @std/cli unstable APIs are tempting (zero deps) but unsafe

## Sources

- JSR: `jsr.io/@cliffy/command@1.2.1`, `/@cliffy/prompt@1.2.1`
- npm: `registry.npmjs.org/{commander,cac,inquirer,prompts,enquirer,ink,yargs}`
- Deno: `github.com/denoland/std/tree/main/cli`
- GitHub: `github.com/c4spar/cliffy`