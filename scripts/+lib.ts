export function success(...args: unknown[]) {
  console.log(`%c${new Date().toISOString()} ${args.join(" ")}`, "color: green; font-weight: bold")
}

export function error(...args: unknown[]) {
  console.error(`%c${new Date().toISOString()} ${args.join(" ")}`, "color: red; font-weight: bold")
}

export function log(...args: unknown[]) {
  console.log(`${new Date().toISOString()}`, ...args)
}

export function absPath(path: string, user: string): string {
  if (path.startsWith("~/")) {
    return path.replace("~", `/home/${user}`)
  }
  return path
}

/**
 * Replaces all occurrences of ${ENV_VAR_NAME} in a template string
 * with the corresponding value from Deno.env.
 * @param template The template string content.
 * @param envGetter Optional custom function to get env vars (defaults to Deno.env.get)
 * @returns The substituted string content.
 * @throws Error if an environment variable is not found.
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

/**
 * Get an environment variable, throwing an error if not found (unless optional)
 */
export function getEnvVar(key: string, isOptional = false): string {
  const value = Deno.env.get(key)
  if (!value && !isOptional) {
    throw new Error(`Missing environment variable: ${key}`)
  }
  return value || ""
}

/**
 * Execute a shell command with optional sudo and return result
 */
export async function runCommand(
  cmd: string[],
  options?: { sudo?: boolean; cwd?: string },
): Promise<{ success: boolean; output: string; error: string }> {
  const command = options?.sudo ? ["sudo", ...cmd] : cmd
  // Inherit stdin for sudo so user can enter password on TTY.
  // piped stdin causes sudo to timeout waiting for password silently.
  const proc = new Deno.Command(command[0], {
    args: command.slice(1),
    stdin: options?.sudo ? "inherit" : "null",
    stdout: "piped",
    stderr: "piped",
    cwd: options?.cwd,
  })

  const output = await proc.output()
  return {
    success: output.code === 0,
    output: new TextDecoder().decode(output.stdout),
    error: new TextDecoder().decode(output.stderr),
  }
}

/**
 * Restart a container on the deploy target. Equivalent to running
 * `ssh $SSH_ADDRESS docker restart <container>` from the dev machine.
 * Use from after.deploy.ts when a service needs to pick up new config
 * that it doesn't hot-reload (Traefik basicAuth usersFile, Gatus YAML).
 *
 * Requires `SSH_ADDRESS` in the env (set by the deploy script).
 */
export async function restartRemoteContainer(container: string): Promise<void> {
  const SSH_ADDRESS = Deno.env.get("SSH_ADDRESS")
  if (!SSH_ADDRESS) {
    throw new Error("SSH_ADDRESS not set")
  }
  log(`Restarting ${container} on ${SSH_ADDRESS}...`)
  const result = await runCommand([
    "ssh",
    SSH_ADDRESS,
    `docker restart ${container}`,
  ])
  if (!result.success) {
    throw new Error(`Failed to restart ${container}: ${result.error}`)
  }
  success(`✓ ${container} restarted`)
}
