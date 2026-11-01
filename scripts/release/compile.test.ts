import { assertEquals, assertThrows } from "@std/assert"
import { RELEASE_TARGETS } from "../../cli/upgrade.ts"
import { parseCompileArgs } from "./compile.ts"

Deno.test("parseCompileArgs builds every release target into dist by default", () => {
  assertEquals(parseCompileArgs([]), { out: "dist", targets: [...RELEASE_TARGETS] })
})

Deno.test("parseCompileArgs takes an output dir and chosen targets", () => {
  assertEquals(
    parseCompileArgs(["--out", "/tmp/r", "--target", "aarch64-apple-darwin"]),
    { out: "/tmp/r", targets: ["aarch64-apple-darwin"] },
  )
})

Deno.test("parseCompileArgs refuses an unknown target or flag", () => {
  assertThrows(
    () => parseCompileArgs(["--target", "x86_64-pc-windows-msvc"]),
    Error,
    "unknown target",
  )
  assertThrows(() => parseCompileArgs(["--outdir", "x"]), Error, "unknown or incomplete")
  assertThrows(() => parseCompileArgs(["--out"]), Error, "unknown or incomplete")
})
