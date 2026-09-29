import { substituteEnvVars } from "./substitute-env.ts"

// Paths are relative to the working directory: deploy runs the hook from its source (possibly
// a jsr.io URL, where `import.meta.url` is no file) with cwd = the staging folder.
const templateFile = "stacks/piped/config.properties.template"
const outputFile = "stacks/piped/config.properties"

// --- Main execution ---
try {
  // 1. Read the template file content
  const templateContent = await Deno.readTextFile(templateFile)

  // 2. Perform the environment variable substitution
  const outputContent = substituteEnvVars(templateContent)

  // 3. Write the new file
  await Deno.writeTextFile(outputFile, outputContent)

  console.log(`Successfully generated '${outputFile}' from '${templateFile}'.`)
} catch (error: unknown) {
  console.error(`An error occurred: ${error instanceof Error ? error.message : String(error)}`)
  Deno.exit(1)
}
