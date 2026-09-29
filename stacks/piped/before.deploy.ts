import { substituteEnvVars } from "./substitute-env.ts"

const templateFile = new URL("config.properties.template", import.meta.url).pathname
const outputFile = new URL("config.properties", import.meta.url).pathname

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
