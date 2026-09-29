/**
 * Replaces every `${ENV_VAR_NAME}` in a template with the value from the environment.
 *
 * A copy of the helper in `scripts/+lib.ts`: a hook runs from its jsr.io URL and cannot import
 * from outside its own stack folder.
 *
 * @param template The template text.
 * @param envGetter Reads one variable; defaults to `Deno.env.get`.
 * @throws Error when a referenced variable is not set.
 */
export function substituteEnvVars(
  template: string,
  envGetter: (key: string) => string | undefined = Deno.env.get.bind(Deno.env),
): string {
  return template.replace(/\${([^}]+)}/g, (_match, envVarName) => {
    const value = envGetter(envVarName.trim())
    if (value === undefined) {
      throw new Error(`Environment variable '${envVarName.trim()}' not found.`)
    }
    return value
  })
}
