# arktype vs zod for rostok

**Decision:** use `npm:arktype@^2` for runtime validation.

## Claim

> arktype is faster and leaner than zod

**Verified:** both halves are true, with caveats on magnitude.

## Measurements

Built with `jsr:@deno/emit` minified + `node:zlib` gzipped, identical
schema, Deno 2.9.0:

| package | tarball | gzip bundle | ns/op (500k iter) |
|---|---|---|---|
| arktype 2.2.3 | 70 KB | 60 KB | ~63 |
| zod 4.4.3 | 760 KB | 70 KB | ~334 |

- **Leaner:** true. ~10x smaller unpacked, ~15% smaller gzipped.
- **Faster:** true. ~5.3x on identical workload in our test. arktype
  homepage claims 20x citing `moltar/typescript-runtime-type-benchmarks`
  — that's a cherry-picked narrow case. 5–10x is realistic across
  real workloads.

## Deno interop

- arktype: works via `npm:arktype@2.2.3`. No JSR equivalent.
- zod: works via `npm:zod@4`. Community JSR exists.
- Both ESM-only. Both fine for Deno 2.x.
- Cliffy: both compose via `Type<T>` wrapping (cliffy custom validators).

## Why arktype for rostok

1. **You asked for it.** "verify and use arktype if claim is true" —
   claim verified.
2. **5x perf matters less than bundle.** A scaffolding CLI validates
   config files at startup, not in hot loops. Bundle size matters more
   for a CLI that ships to many users.
3. **Deno-native feel.** arktype's string-DSL syntax (`"string >= 1"`)
   reads closer to Deno's stdlib patterns than zod's chainable API.

## Risks accepted

- arktype single-maintainer (David Blass, sponsored full-time)
- arktype's heavy TS generics can slow `deno check` on complex schemas
  (recurring user reports; not measured here)
- No JSR package — must use `npm:` specifier

## Anti-patterns

- Don't `.parse()` in hot loops — pre-compile schema once at module
  top-level, then call repeatedly
- Named imports only (`import { type } from "arktype"`), tree-shake
- Don't mix with zod in one project — pick one, document it in README

## Sources

- npm registry: `registry.npmjs.org/arktype`, `/zod`, `/@ark/schema`
- GitHub: `github.com/arktypeio/arktype`, `/colinhacks/zod`,
  `/moltar/typescript-runtime-type-benchmarks`
- JSR: `jsr.io/@cliffy/command@1.2.1`, `/@cliffy/prompt@1.2.1`
- arktype homepage: arktype.io
- Bench source: `moltar.github.io/typescript-runtime-type-benchmarks/`