// Paths are relative to the working directory: deploy runs the hook from its source (possibly
// a jsr.io URL, where `import.meta.url` is no file) with cwd = the staging folder.
const settingsTemplate = Deno.readTextFileSync("stacks/searxng/searxng-settings.yml")

const filled = settingsTemplate.replace(
  /\$\{SEARXNG_SECRET_KEY\}/g,
  Deno.env.get("SEARXNG_SECRET_KEY") || "",
)

Deno.writeTextFileSync("stacks/searxng/settings.yml", filled)
console.log("settings.yml generated in stack dir")
