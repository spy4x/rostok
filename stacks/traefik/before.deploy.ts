// Copies server-specific Traefik dynamic config files into the dynamic/
// directory before deployment. This allows per-server overrides (e.g.,
// authelia middleware + opencode-web route on home) while keeping a shared
// base config (00-base.yml) used by all servers.
//
// Also generates .htpasswd file for dashboard-auth by bcrypt-hashing the
// plaintext password decoded from BASIC_AUTH_BASE64. We decode the base64
// rather than reading BASIC_AUTH_PASSWORD directly because Deno's
// --env-file loader mangles `$` chars in bcrypt hashes (`$2y$05$...`),
// corrupting the .htpasswd users.
// Traefik's basicAuth middleware caches the file at startup — the
// after.deploy.ts hook restarts hl-traefik after deploy so it picks up
// the new file.
//
// Expected file location on server:
//   configs/traefik/dynamic/*.yml  →  stacks/traefik/dynamic/*.yml

const DYNAMIC_DIR = "stacks/traefik/dynamic"
const configSource = "configs/traefik/dynamic"

/**
 * Generate .htpasswd file by bcrypt-hashing the plaintext password
 * extracted from BASIC_AUTH_BASE64. Falls back to a legacy bcrypt from
 * BASIC_AUTH_PASSWORD if base64 isn't set (legacy support).
 *
 * Writes to dynamic/ so it's mounted into Traefik at /etc/traefik/dynamic/.htpasswd.
 */
async function generateHtpasswd(): Promise<void> {
  const user = Deno.env.get("BASIC_AUTH_USER")
  const base64Auth = Deno.env.get("BASIC_AUTH_BASE64")

  if (!user) {
    console.log("BASIC_AUTH_USER not set, skipping htpasswd generation")
    return
  }

  let plainPassword: string | null = null

  if (base64Auth) {
    try {
      const decoded = atob(base64Auth)
      const colonIdx = decoded.indexOf(":")
      if (colonIdx > 0) {
        plainPassword = decoded.substring(colonIdx + 1)
      }
    } catch (err) {
      console.log(`Failed to decode BASIC_AUTH_BASE64: ${err}`)
    }
  }

  if (!plainPassword) {
    const legacyPassword = Deno.env.get("BASIC_AUTH_PASSWORD")
    if (legacyPassword && legacyPassword.startsWith("$2")) {
      // Already a bcrypt hash — write it directly
      const htpasswdPath = `${DYNAMIC_DIR}/.htpasswd`
      const content = `${user}:${legacyPassword}\n`
      await Deno.writeTextFile(htpasswdPath, content, { mode: 0o600 })
      console.log(`Generated ${htpasswdPath} (legacy bcrypt from BASIC_AUTH_PASSWORD)`)
      return
    }
    if (legacyPassword) {
      plainPassword = legacyPassword
    }
  }

  if (!plainPassword) {
    console.log("No password source found (set BASIC_AUTH_BASE64 or BASIC_AUTH_PASSWORD)")
    return
  }

  // Run htpasswd -nbB to bcrypt the plaintext password
  const htpasswdCmd = new Deno.Command("htpasswd", {
    args: ["-nbB", user, plainPassword],
    stdout: "piped",
    stderr: "piped",
  })
  const output = await htpasswdCmd.output()
  if (!output.success) {
    throw new Error(`htpasswd failed: ${new TextDecoder().decode(output.stderr)}`)
  }
  // Strip the trailing newline htpasswd prints (avoids double-newline in file)
  let content = new TextDecoder().decode(output.stdout).trimEnd() + "\n"
  // htpasswd may wrap; unwrap to single line per entry
  content = content.replace(/\n/g, "")
  const htpasswdPath = `${DYNAMIC_DIR}/.htpasswd`
  await Deno.writeTextFile(htpasswdPath, content, { mode: 0o600 })
  console.log(`Generated ${htpasswdPath} (bcrypt from BASIC_AUTH_BASE64 plaintext)`)
}

// Copy server-specific config if present
try {
  const entries: Deno.DirEntry[] = []
  for await (const entry of Deno.readDir(configSource)) {
    entries.push(entry)
  }

  if (entries.length > 0) {
    const destDir = DYNAMIC_DIR
    for (const entry of entries) {
      if (entry.isFile && (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml"))) {
        const destPath = `${destDir}/${entry.name}`
        await Deno.copyFile(`${configSource}/${entry.name}`, destPath)
        console.log(`Copied ${configSource}/${entry.name} → ${destPath}`)
      }
    }
  } else {
    console.log(`No server-specific Traefik configs found in ${configSource}`)
  }
} catch (err) {
  if (err instanceof Deno.errors.NotFound) {
    console.log(`No server-specific Traefik configs (${configSource} not found)`)
  } else {
    throw err
  }
}

// Generate htpasswd after all configs are copied
await generateHtpasswd()
