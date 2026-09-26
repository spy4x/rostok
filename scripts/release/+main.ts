/**
 * Refuses a release tag that does not match the package version.
 *
 * Woodpecker runs this before `deno publish` on a `v*` tag. `deno publish`
 * skips a version JSR already has and exits 0, so without this guard a tag
 * pushed without the version bump goes green and publishes nothing. It also
 * catches a bump that changed only one of the two version sources, which
 * would ship a binary whose `rostok --version` prints the old number.
 *
 * ```bash
 * CI_COMMIT_TAG=v1.2.1 deno run -R --allow-env=CI_COMMIT_TAG scripts/release/+main.ts
 * ```
 *
 * @module
 */
import { VERSION } from "../../cli/version.ts"

/** Reads the `version` field of `deno.jsonc`; it carries comments, so no JSON.parse. */
export function readVersion(configText: string): string | undefined {
  return configText.match(/^\s*"version"\s*:\s*"([^"]+)"/m)?.[1]
}

/**
 * Compares a tag with both version sources.
 *
 * @param tag The pushed tag, e.g. `v1.2.1`; empty or missing outside a tag build.
 * @param versions Each version source's declared version, keyed by file.
 * @returns Every problem found, one sentence each; empty when the tag is `v` + the version.
 */
export function checkReleaseTag(
  tag: string | undefined,
  versions: Record<string, string | undefined>,
): string[] {
  if (!tag) return ["No tag: this guard runs only on a tag build (CI_COMMIT_TAG is empty)."]
  const problems: string[] = []
  for (const [file, version] of Object.entries(versions)) {
    if (!version) problems.push(`${file} declares no version.`)
    else if (`v${version}` !== tag) {
      problems.push(`${file} is at ${version}, but the tag is ${tag}.`)
    }
  }
  return problems
}

if (import.meta.main) {
  const config = Deno.readTextFileSync(new URL("../../deno.jsonc", import.meta.url))
  const problems = checkReleaseTag(Deno.env.get("CI_COMMIT_TAG"), {
    "deno.jsonc": readVersion(config),
    "cli/version.ts": VERSION,
  })
  if (problems.length > 0) {
    console.error(`Release tag refused:\n${problems.map((p) => `  ${p}`).join("\n")}`)
    Deno.exit(1)
  }
  console.log("Release tag matches deno.jsonc and cli/version.ts.")
}
