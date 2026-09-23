// after.deploy.ts for gatus stack — restart hl-gatus so it picks up the
// new config.yaml. Gatus does not watch its config at runtime.
//
// Self-contained per the deploy hook contract: no import out of this
// stack directory (deploy runs this file from the installed package,
// an https:// URL when installed from JSR, where a relative parent
// import can't resolve).

const SSH_ADDRESS = Deno.env.get("SSH_ADDRESS")
if (!SSH_ADDRESS) {
  console.error("after.deploy.ts FAILED: SSH_ADDRESS not set")
  Deno.exit(1)
}

const result = await new Deno.Command("ssh", {
  args: [SSH_ADDRESS, "docker", "restart", "hl-gatus"],
  stdout: "inherit",
  stderr: "inherit",
}).output()

if (!result.success) {
  console.error("after.deploy.ts FAILED: could not restart hl-gatus")
  Deno.exit(1)
}

console.log("hl-gatus restarted")
