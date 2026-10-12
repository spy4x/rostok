// Writes Authelia's two config files into the deploy staging folder, each only when the server
// does not bring its own:
//
//   configs/authelia/configuration.yml   from the stack's settings
//   configs/authelia/users.yml           one first user, AUTHELIA_ADMIN_USER
//
// compose.yml mounts both from `${PATH_APPS}/configs/authelia/`. A file the operator keeps in
// `servers/<server>/configs/authelia/` is already in staging when this hook runs (deploy copies
// `configs/` first) and is left alone, each of the two on its own. A per-server hook
// (`servers/<server>/configs/authelia/before.deploy.ts`) runs after this one, so this hook does
// not see that hook's files yet: it generates both, and a file the per-server hook then writes
// replaces the generated one before anything is synced. The server's file wins either way.
//
// The generated configuration.yml holds no secret and no `${...}` placeholder: Authelia does not
// expand placeholders in its config file, it would use the placeholder text itself as the
// secret. The session secret, the storage encryption key and the reset-password signing secret
// reach Authelia as `AUTHELIA_*` environment variables (compose.yml), which win over the file.
//
// With AUTHELIA_SMTP_PASSWORD set, the hook also puts AUTHELIA_NOTIFIER_SMTP_PASSWORD into the
// staged `stacks/authelia/compose.yml`, in place of a marker line (see `withSmtpPassword`).
//
// Last, the hook puts a hash of the two staged files into the staged compose.yml as a label of
// the authelia service (see `withConfigHash`). A deploy replaces a changed file on the server,
// but each is mounted as a single file, so the running container keeps the old one and compose
// sees nothing to do. The changed label makes compose recreate the container exactly when a
// file changed. A file a per-server hook writes later is not in that hash (README, "The
// server's own files win").
//
// The first user's password is AUTHELIA_ADMIN_PASSWORD from the server's `.env`, where
// `stack add` generated it, like every other stack's first password. Only its hash is written;
// neither the password nor the hash is printed. The hash is PBKDF2-SHA512, which Authelia reads
// and Web Crypto computes on Deno, Node and Bun alike; argon2id, Authelia's own default, is in
// neither Web Crypto nor `@std`. The salt is derived from the session secret, the user name and
// the password, so every deploy writes the same file and Authelia is not restarted for nothing.
//
// Self-contained per the deploy hook contract: no import, and every path is relative to the
// working directory (the staging folder), never to import.meta.url, because a shipped hook runs
// from an https:// URL.

/** Authelia's config folder in the deploy staging tree, relative to the hook's working directory. */
export const STAGED_DIR = "configs/authelia"

/** The stack's compose.yml in the deploy staging tree, relative to the hook's working directory. */
const STAGED_COMPOSE = "stacks/authelia/compose.yml"

/** The comment line in compose.yml that the hook replaces with the SMTP password variable. */
export const SMTP_PASSWORD_MARKER = "# rostok:smtp-password"

/** What replaces the marker: Authelia's own variable, required from the server's `.env`. */
const SMTP_PASSWORD_LINE = "- AUTHELIA_NOTIFIER_SMTP_PASSWORD=${AUTHELIA_SMTP_PASSWORD:?}"

/** The comment line in compose.yml that the hook replaces with the config hash label. */
export const CONFIG_HASH_MARKER = "# rostok:config-hash"

/** The label of the authelia service that holds the hash of its two config files. */
export const CONFIG_HASH_LABEL = "rostok.authelia.config-hash"

/** PBKDF2-SHA512 rounds: Authelia's own default for this algorithm. */
const PBKDF2_ITERATIONS = 310_000

/** The three secrets compose.yml passes to Authelia through the environment. */
export const SECRET_KEYS = [
  "AUTHELIA_SESSION_SECRET",
  "AUTHELIA_STORAGE_ENCRYPTION_KEY",
  "AUTHELIA_IDENTITY_VALIDATION_RESET_PASSWORD_JWT_SECRET",
] as const

type GetEnv = (key: string) => string | undefined

/** A YAML double-quoted scalar: JSON string syntax is valid YAML. */
function quote(value: string): string {
  return JSON.stringify(value)
}

/**
 * The value of `key`, trimmed, with `${DOMAIN}` filled in (a hook gets `.env` values as written).
 * Unset or blank gives `fallback`; without a fallback it throws, naming the key.
 */
function setting(getEnv: GetEnv, key: string, fallback?: string): string {
  const raw = getEnv(key)?.trim() || fallback
  if (raw === undefined) throw new Error(`${key} is not set in the server's .env`)
  return raw.replaceAll("${DOMAIN}", getEnv("DOMAIN")?.trim() ?? "")
}

/**
 * Authelia's configuration.yml for the stack's settings. Every host behind Authelia asks for the
 * password (`one_factor`). Password reset stays off unless mail can be sent
 * (AUTHELIA_SMTP_ADDRESS and AUTHELIA_SMTP_SENDER): without SMTP a reset link would only be
 * written to a file on the server. Throws when DOMAIN is missing, when only one of the two SMTP
 * settings is given, or when there is an SMTP password but no SMTP server.
 */
export function renderConfiguration(getEnv: GetEnv): string {
  const domain = setting(getEnv, "DOMAIN")
  const host = setting(getEnv, "AUTHELIA_DOMAIN", "auth.${DOMAIN}")
  const smtpAddress = setting(getEnv, "AUTHELIA_SMTP_ADDRESS", "")
  const smtpSender = setting(getEnv, "AUTHELIA_SMTP_SENDER", "")
  const smtpUsername = setting(getEnv, "AUTHELIA_SMTP_USERNAME", "")
  if (Boolean(smtpAddress) !== Boolean(smtpSender)) {
    throw new Error("set both AUTHELIA_SMTP_ADDRESS and AUTHELIA_SMTP_SENDER, or neither")
  }
  if (hasSmtpPassword(getEnv) && !smtpAddress) {
    // The password alone makes Authelia see an SMTP notifier beside the file one and refuse to
    // start.
    throw new Error(
      "AUTHELIA_SMTP_PASSWORD is set without AUTHELIA_SMTP_ADDRESS: set it or drop it",
    )
  }
  const notifier = smtpAddress
    ? [
      "  smtp:",
      `    address: ${quote(smtpAddress)}`,
      `    sender: ${quote(smtpSender)}`,
      ...(smtpUsername ? [`    username: ${quote(smtpUsername)}`] : []),
    ]
    : [
      "  filesystem:",
      "    filename: /data/notifications.yml",
    ]
  return [
    "# Generated by rostok at deploy (stacks/authelia/before.deploy.ts). Do not edit on the server:",
    "# the next deploy overwrites it. To change it, keep your own copy in",
    "# servers/<server>/configs/authelia/configuration.yml. Secrets do not belong in this file:",
    "# they reach Authelia as AUTHELIA_* environment variables.",
    "session:",
    "  cookies:",
    `    - domain: ${quote(domain)}`,
    `      authelia_url: ${quote(`https://${host}`)}`,
    "  redis:",
    "    host: authelia-redis",
    "    port: 6379",
    "authentication_backend:",
    "  password_reset:",
    `    disable: ${smtpAddress ? "false" : "true"}`,
    "  file:",
    "    path: /config/users.yml",
    "access_control:",
    "  default_policy: one_factor",
    "storage:",
    "  local:",
    "    path: /data/db.sqlite",
    "totp:",
    `  issuer: ${quote(domain)}`,
    "notifier:",
    ...notifier,
    "",
  ].join("\n")
}

/** Whether an SMTP password is set: only then may Authelia get the variable that carries it. */
export function hasSmtpPassword(getEnv: GetEnv): boolean {
  return Boolean(getEnv("AUTHELIA_SMTP_PASSWORD"))
}

/**
 * `composeText` with `line` in place of the one line that is `marker`, keeping its indent. A
 * line that already starts with `existing` is replaced instead, so a second run changes nothing.
 * Throws when the text holds neither, or the marker more than once: the line would silently not
 * reach Authelia.
 */
function setLine(composeText: string, marker: string, existing: string, line: string): string {
  const lines = composeText.split("\n")
  let at = lines.findIndex((l) => l.trim().startsWith(existing))
  if (at < 0) {
    const markers = lines.flatMap((l, i) => l.trim() === marker ? [i] : [])
    if (markers.length !== 1) {
      throw new Error(
        `compose.yml must hold the line "${marker}" exactly once (found ${markers.length})`,
      )
    }
    at = markers[0]
  }
  lines[at] = lines[at].slice(0, lines[at].length - lines[at].trimStart().length) + line
  return lines.join("\n")
}

/**
 * `composeText` (the stack's compose.yml) with the marker line replaced by the variable that hands
 * Authelia the SMTP password. Authelia reads even an empty AUTHELIA_NOTIFIER_SMTP_PASSWORD as "an
 * SMTP notifier is configured" and refuses to start beside the file notifier, so the variable
 * may only exist when SMTP is used.
 */
export function withSmtpPassword(composeText: string): string {
  return setLine(composeText, SMTP_PASSWORD_MARKER, SMTP_PASSWORD_LINE, SMTP_PASSWORD_LINE)
}

/**
 * `composeText` with the label that holds the SHA-256 of the two config files, in place of its
 * marker line. Compose recreates a container whose labels changed, and only then does Authelia
 * get a file the deploy replaced: a single-file mount keeps pointing at the old file.
 */
export async function withConfigHash(
  composeText: string,
  configuration: string,
  users: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([configuration, users])),
  )
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
  const existing = `- "${CONFIG_HASH_LABEL}=`
  return setLine(composeText, CONFIG_HASH_MARKER, existing, `${existing}${hex}"`)
}

/** Base64 as Authelia's PBKDF2 format writes it: `.` for `+`, no padding. */
function adaptedBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", ".").replaceAll("=", "")
}

/** `password` as a `$pbkdf2-sha512$...` hash, a format Authelia's file backend reads. */
export async function hashPassword(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-512", salt, iterations: PBKDF2_ITERATIONS },
    key,
    512,
  )
  return `$pbkdf2-sha512$${PBKDF2_ITERATIONS}$${adaptedBase64(salt)}$${
    adaptedBase64(new Uint8Array(bits))
  }`
}

/** A 16-byte salt that is the same for the same secret, user and password, and tells nothing about them. */
async function deriveSalt(
  secret: string,
  user: string,
  password: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`users.yml\n${user}\n${password}`),
  )
  return new Uint8Array(mac).slice(0, 16)
}

/**
 * Authelia's users.yml with one user: AUTHELIA_ADMIN_USER, in the group `admins`, with the hash
 * of AUTHELIA_ADMIN_PASSWORD. Throws when a setting it needs is missing.
 */
export async function renderUsers(getEnv: GetEnv): Promise<string> {
  const user = setting(getEnv, "AUTHELIA_ADMIN_USER", "admin")
  const email = setting(getEnv, "AUTHELIA_ADMIN_EMAIL", "admin@${DOMAIN}")
  // Not trimmed: a password is used exactly as written.
  const password = getEnv("AUTHELIA_ADMIN_PASSWORD")
  const secret = getEnv("AUTHELIA_SESSION_SECRET")
  if (!password || !secret) {
    throw new Error(
      "AUTHELIA_ADMIN_PASSWORD and AUTHELIA_SESSION_SECRET must be set in the server's .env to " +
        `write the first user, or keep your own ${STAGED_DIR}/users.yml for this server`,
    )
  }
  const hash = await hashPassword(password, await deriveSalt(secret, user, password))
  return [
    "# Generated by rostok at deploy (stacks/authelia/before.deploy.ts). Do not edit on the server:",
    "# the next deploy overwrites it. To add users, keep your own copy in",
    "# servers/<server>/configs/authelia/users.yml.",
    "users:",
    `  ${quote(user)}:`,
    "    disabled: false",
    `    displayname: ${quote(user)}`,
    `    password: ${quote(hash)}`,
    `    email: ${quote(email)}`,
    "    groups:",
    "      - admins",
    "",
  ].join("\n")
}

/** Whether `path` exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path)
    return true
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false
    throw err
  }
}

/** Run the hook. `stagingDir` is the deploy staging folder. */
export async function main(stagingDir: string, getEnv: GetEnv): Promise<void> {
  const missing = SECRET_KEYS.filter((key) => !getEnv(key))
  if (missing.length) {
    throw new Error(`missing in the server's .env: ${missing.join(", ")}`)
  }
  if (hasSmtpPassword(getEnv)) {
    const composePath = `${stagingDir}/${STAGED_COMPOSE}`
    await Deno.writeTextFile(composePath, withSmtpPassword(await Deno.readTextFile(composePath)))
    console.log(`${STAGED_COMPOSE}: SMTP password variable added`)
  }
  const dir = `${stagingDir}/${STAGED_DIR}`
  await Deno.mkdir(dir, { recursive: true })
  const files: [name: string, mode: number, render: () => string | Promise<string>][] = [
    ["configuration.yml", 0o644, () => renderConfiguration(getEnv)],
    // The password hash is for Authelia alone.
    ["users.yml", 0o600, () => renderUsers(getEnv)],
  ]
  for (const [name, mode, render] of files) {
    if (await exists(`${dir}/${name}`)) {
      console.log(`${STAGED_DIR}/${name}: keeping the server's own file`)
      continue
    }
    await Deno.writeTextFile(`${dir}/${name}`, await render(), { mode })
    console.log(`${STAGED_DIR}/${name}: generated`)
  }
  const composePath = `${stagingDir}/${STAGED_COMPOSE}`
  await Deno.writeTextFile(
    composePath,
    await withConfigHash(
      await Deno.readTextFile(composePath),
      await Deno.readTextFile(`${dir}/configuration.yml`),
      await Deno.readTextFile(`${dir}/users.yml`),
    ),
  )
  console.log(`${STAGED_COMPOSE}: config hash label set`)
}

if (import.meta.main) {
  try {
    await main(".", (key) => Deno.env.get(key))
  } catch (err) {
    console.error(
      "before.deploy.ts (authelia) FAILED:",
      err instanceof Error ? err.message : String(err),
    )
    Deno.exit(1)
  }
}
