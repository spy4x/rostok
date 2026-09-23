// before.deploy.ts for gatus — overwrites the shipped starter config
// (stacks/gatus/config.yml, mounted at /config/config.yaml) with a
// server-specific one, when the operator wrote
// servers/<server>/configs/gatus.yml. Leaves the shipped starter (zero
// endpoints) in place otherwise, so `stack add gatus -n` plus deploy
// gives a container that starts with no manual config step.
//
// Self-contained per the deploy hook contract: no import out of this
// stack directory.

const OVERRIDE_PATH = "configs/gatus.yml"
const TARGET_PATH = "stacks/gatus/config.yml"

async function main(): Promise<void> {
  try {
    await Deno.copyFile(OVERRIDE_PATH, TARGET_PATH)
    console.log(`Copied ${OVERRIDE_PATH} → ${TARGET_PATH}`)
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.log(
        `No server-specific Gatus config (${OVERRIDE_PATH} not found) — using shipped default`,
      )
    } else {
      throw err
    }
  }
}

if (import.meta.main) {
  await main()
}
