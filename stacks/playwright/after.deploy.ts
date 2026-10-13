// after.deploy.ts for the playwright stack: connect Open WebUI to the MCP proxy's own network.
//
// The MCP endpoint has no authentication, so compose keeps `hl-playwright-mcp` off the shared
// `proxy` network, on a network of its own (spy4x/rostok#338). Its one client, Open WebUI, is
// another stack, and compose cannot attach another project's container. This hook does it after
// every deploy that includes this stack, because a recreated container loses the connection.
// Open WebUI's own after.deploy.ts does the same after a deploy that includes that stack. Without
// Open WebUI on the server this hook does nothing.
//
// Self-contained per the deploy hook contract: no import out of this stack directory. It uses the
// SSH_HOST/SSH_PORT/SSH_USER keys every hook gets; SSH_PORT is set only when the address carried
// a port, so `-p` is added only then. On a local server (no SSH_HOST) it runs the same script
// with `sh -c` on this machine.

/** The network compose creates for the MCP proxy (`networks.mcp.name` in compose.yml). */
const NETWORK = `hl-playwright-mcp`
/** The one container allowed to reach the MCP proxy. */
const CLIENT = `hl-open-webui`

/** A Docker container or network name: safe to put into a shell command unquoted. */
function isDockerName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)
}

/** Digits only, 1-65535. */
function isValidPort(port: string): boolean {
  return /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535
}

/**
 * The shell script that connects `client` to `network`, for the server's shell.
 *
 * It exits 0 when the network or the client container does not exist (that stack is not deployed
 * there) and when the client is already connected, and non-zero when the connection could not be
 * made. Throws on a name that is not a plain Docker name. Exported for tests; no I/O.
 * stacks/open-webui/after.deploy.ts holds a copy: a hook cannot import from another stack.
 */
export function buildConnectScript(network: string, client: string): string {
  for (const name of [network, client]) {
    if (!isDockerName(name)) throw new Error(`invalid Docker name "${name}"`)
  }
  const connected =
    `docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' ` +
    `${client} | tr ' ' '\\n' | grep -qx ${network}`
  return [
    `docker network inspect ${network} >/dev/null 2>&1 || { echo "no ${network} network on this server: nothing to connect"; exit 0; }`,
    `docker inspect ${client} >/dev/null 2>&1 || { echo "${client} is not on this server: nothing to connect"; exit 0; }`,
    `if ${connected}; then echo "${client} is already on ${network}"; exit 0; fi`,
    `docker network connect ${network} ${client} && echo "${client} connected to ${network}"`,
  ].join(`\n`)
}

/**
 * The argv for `ssh [-p <port>] -o ConnectTimeout=10 -o BatchMode=yes -- [user@]host <script>`.
 * Throws when `port` is set but is not a port number. Exported for tests; no I/O.
 */
export function buildSshArgs(
  host: string,
  port: string | undefined,
  user: string | undefined,
  script: string,
): string[] {
  if (port !== undefined && !isValidPort(port)) {
    throw new Error(`invalid SSH_PORT "${port}": expected digits 1-65535`)
  }
  return [
    ...(port !== undefined ? [`-p`, port] : []),
    `-o`,
    `ConnectTimeout=10`,
    `-o`,
    `BatchMode=yes`,
    `--`,
    user ? `${user}@${host}` : host,
    script,
  ]
}

if (import.meta.main) {
  // A local server (SSH_ADDRESS=local) has no SSH_HOST: the script then runs on this machine.
  const SSH_HOST = Deno.env.get(`SSH_HOST`)

  let command: Deno.Command
  try {
    const script = buildConnectScript(NETWORK, CLIENT)
    const io = { stdin: `null`, stdout: `inherit`, stderr: `inherit` } as const
    command = SSH_HOST
      ? new Deno.Command(`ssh`, {
        args: buildSshArgs(
          SSH_HOST,
          Deno.env.get(`SSH_PORT`) || undefined,
          Deno.env.get(`SSH_USER`) || undefined,
          script,
        ),
        ...io,
      })
      : new Deno.Command(`sh`, { args: [`-c`, script], ...io })
  } catch (err) {
    console.error(`after.deploy.ts FAILED:`, err instanceof Error ? err.message : String(err))
    Deno.exit(1)
  }

  if (!(await command.output()).success) {
    console.error(`after.deploy.ts FAILED: could not connect ${CLIENT} to ${NETWORK}`)
    Deno.exit(1)
  }
}
