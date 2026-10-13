// `IMAGE_POLICY=pinned|latest`: whether `rostok stack add` pins each
// image to the version it resolves today, or leaves the tags floating.
//
// Set once for the project in `.env.root`; a server's own `.env` wins
// when it sets the key too. Missing (or empty) everywhere means `pinned`.

import { join } from "@std/path"
import { decodeEnvValue, readEnvFile, writeEnvFilePreservingFormat } from "../env-files.ts"
import { UserError } from "../errors.ts"
import { type PromptFn, promptValue } from "../prompts.ts"
import { serverDirFor } from "../server-keys.ts"

export type ImagePolicy = "pinned" | "latest"

export const IMAGE_POLICY_KEY = "IMAGE_POLICY"
export const DEFAULT_IMAGE_POLICY: ImagePolicy = "pinned"

function isPolicy(value: string): value is ImagePolicy {
  return value === "pinned" || value === "latest"
}

/** The policy `path` sets, undefined when it doesn't set one. Throws naming the file on any other value. */
async function policyIn(path: string): Promise<ImagePolicy | undefined> {
  const entry = (await readEnvFile(path)).findLast((e) => e.key === IMAGE_POLICY_KEY)
  const value = entry ? decodeEnvValue(entry.value).trim() : ""
  if (value === "") return undefined
  if (!isPolicy(value)) {
    throw new UserError(
      `${path}: ${IMAGE_POLICY_KEY} must be "pinned" or "latest", not "${value}".`,
    )
  }
  return value
}

/** The policy in force for `serverName`: its `.env`, then the project's `.env.root`, then `pinned`. */
export async function resolveImagePolicy(cwd: string, serverName: string): Promise<ImagePolicy> {
  // Both files are checked, so a bad project value is reported even when a server overrides it.
  const project = await policyIn(join(cwd, ".env.root"))
  const server = await policyIn(join(serverDirFor(cwd, serverName), ".env"))
  return server ?? project ?? DEFAULT_IMAGE_POLICY
}

export interface ChooseImagePolicyOptions {
  cwd: string
  /** `--var` values; `IMAGE_POLICY` here wins over everything. */
  providedVars?: Record<string, string>
  nonInteractive?: boolean
  promptFn?: PromptFn
}

/**
 * The wizard's one question. Writes the project's policy to `.env.root`
 * and returns it. A `--var IMAGE_POLICY=…` always wins; a policy already
 * in `.env.root` is kept without asking; otherwise the user is asked,
 * and a non-interactive run takes `pinned`.
 */
export async function chooseImagePolicy(opts: ChooseImagePolicyOptions): Promise<ImagePolicy> {
  const path = join(opts.cwd, ".env.root")
  const provided = opts.providedVars?.[IMAGE_POLICY_KEY]
  if (provided === undefined) {
    const existing = await policyIn(path)
    if (existing) return existing
  }
  const value = await promptValue({
    key: IMAGE_POLICY_KEY,
    label: "Image versions: pinned (change only when you run `rostok images update`) " +
      `or latest (always the newest)? (${IMAGE_POLICY_KEY})`,
    provided,
    fallback: DEFAULT_IMAGE_POLICY,
    validate: (v) => isPolicy(v) || `must be "pinned" or "latest"`,
    nonInteractive: opts.nonInteractive,
    promptFn: opts.promptFn,
  })
  await writeEnvFilePreservingFormat(path, [{ key: IMAGE_POLICY_KEY, value }])
  return value as ImagePolicy
}
