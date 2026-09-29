// before.deploy.ts for zond — overwrites the shipped starter config (stacks/zond/config.yml,
// mounted at /app/zond.yaml) with a server-specific one, when the operator wrote
// servers/<server>/configs/zond.yaml. Leaves the shipped starter in place otherwise, so
// `stack add zond -n` plus deploy gives a container that starts with no manual config step.
//
// Self-contained per the deploy hook contract: no import out of this stack directory. Paths are
// relative to the working directory (the staging directory), not to import.meta.url, because a
// shipped hook runs from an https:// URL.

const OVERRIDE_PATH = "configs/zond.yaml"
const TARGET_PATH = "stacks/zond/config.yml"

async function main(): Promise<void> {
  try {
    await Deno.copyFile(OVERRIDE_PATH, TARGET_PATH)
    console.log(`Copied ${OVERRIDE_PATH} → ${TARGET_PATH}`)
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.log(`No server-specific zond config (${OVERRIDE_PATH} not found), using the starter`)
    } else {
      throw err
    }
  }
}

if (import.meta.main) {
  await main()
}
