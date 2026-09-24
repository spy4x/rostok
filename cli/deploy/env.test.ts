import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert"
import { UserError } from "../errors.ts"
import {
  expandEnvRefs,
  resolveDeployEnv,
  resolvePathApps,
  resolvePgid,
  resolvePuid,
  resolveSshUser,
} from "./env.ts"

const ROOT_ENV_PATH = ".env.root"

Deno.test("resolveSshUser: uses SSH_USER when present", () => {
  assertEquals(resolveSshUser({ SSH_USER: "deploy" }), "deploy")
})

Deno.test("resolveSshUser: a .env with only HOMELAB_USER has no remote user", () => {
  assertEquals(resolveSshUser({ HOMELAB_USER: "homelab" }), "")
})

Deno.test("resolveSshUser: a .env with only USER (the pre-1.0.4 wizard key) has no remote user", () => {
  assertEquals(resolveSshUser({ USER: "x" }), "")
})

Deno.test("resolveSshUser: never reads the shell's own USER — only the given map", () => {
  const previous = Deno.env.get("USER")
  Deno.env.set("USER", "shell-user-should-be-ignored")
  try {
    assertEquals(resolveSshUser({}), "")
  } finally {
    if (previous === undefined) Deno.env.delete("USER")
    else Deno.env.set("USER", previous)
  }
})

Deno.test("resolvePathApps: uses PATH_APPS when present, no notice", () => {
  const result = resolvePathApps({ PATH_APPS: "/srv/apps" })
  assertEquals(result.value, "/srv/apps")
  assertEquals(result.notice, undefined)
})

Deno.test("resolvePathApps: falls back to the default with a notice", () => {
  const result = resolvePathApps({})
  assertEquals(result.value, "/srv/apps")
  assertStringIncludes(result.notice ?? "", "PATH_APPS not set")
})

Deno.test("resolvePuid: falls back to 1000 with a notice", () => {
  const result = resolvePuid({})
  assertEquals(result.value, "1000")
  assertStringIncludes(result.notice ?? "", "PUID not set")
})

Deno.test("resolvePuid: uses PUID when present, no notice", () => {
  const result = resolvePuid({ PUID: "1001" })
  assertEquals(result.value, "1001")
  assertEquals(result.notice, undefined)
})

Deno.test("resolvePgid: falls back to 1000 with a notice", () => {
  const result = resolvePgid({})
  assertEquals(result.value, "1000")
  assertStringIncludes(result.notice ?? "", "PGID not set")
})

Deno.test("resolveDeployEnv: throws UserError naming every missing key and both files", () => {
  const err = assertThrows(
    () => resolveDeployEnv({ SSH_ADDRESS: "root@example.com" }, "servers/home/.env", ROOT_ENV_PATH),
    UserError,
  )
  assertStringIncludes(err.message, "servers/home/.env")
  assertStringIncludes(err.message, ROOT_ENV_PATH)
  // PATH_APPS/PUID/PGID are never reported missing — they always resolve
  // via their own defaults.
  for (const key of ["SSH_USER", "VOLUMES_PATH", "DOCKER_GROUP_ID"]) {
    assertStringIncludes(err.message, key)
  }
  assertEquals(err.message.includes("PATH_APPS"), false)
  assertEquals(err.message.includes("PUID"), false)
  assertEquals(err.message.includes("PGID"), false)
  // SSH_ADDRESS was supplied — must not be reported missing.
  assertEquals(err.message.includes("SSH_ADDRESS,"), false)
})

Deno.test("resolveDeployEnv: succeeds and fills SSH_USER/PATH_APPS/PUID/PGID when all keys resolve", () => {
  const { env, notices } = resolveDeployEnv(
    {
      // A bare ssh_config alias (no user@ part) has nothing to compare
      // against SSH_USER, so it can differ freely — see the
      // SSH_USER/SSH_ADDRESS agreement tests below for the mismatch case.
      SSH_ADDRESS: "home-alias",
      SSH_USER: "deploy",
      VOLUMES_PATH: "/srv/volumes",
      DOCKER_GROUP_ID: "988",
    },
    "servers/home/.env",
    ROOT_ENV_PATH,
  )
  assertEquals(env.SSH_USER, "deploy")
  assertEquals(env.PATH_APPS, "/srv/apps")
  assertEquals(env.PUID, "1000")
  assertEquals(env.PGID, "1000")
  // PATH_APPS, PUID, PGID notices.
  assertEquals(notices.length, 3)
})

Deno.test("resolveDeployEnv: a key present only in .env.root satisfies the required-key check", () => {
  // compose reads --env-file=.env.root --env-file=.env, so a required key
  // declared only in .env.root (a cross-server value) is not "missing" —
  // the caller merges .env.root into `env` before calling this.
  const merged = {
    // from .env.root
    VOLUMES_PATH: "/srv/volumes",
    // from servers/<server>/.env — a bare alias, no user@ part to
    // disagree with SSH_USER.
    SSH_ADDRESS: "home-alias",
    SSH_USER: "deploy",
    DOCKER_GROUP_ID: "988",
  }
  const { env } = resolveDeployEnv(merged, "servers/home/.env", ROOT_ENV_PATH)
  assertEquals(env.VOLUMES_PATH, "/srv/volumes")
})

Deno.test("resolveDeployEnv: the server .env value wins over .env.root on conflict", () => {
  // Caller merge order is {...rootEnv, ...serverEnv} — assert that shape
  // produces the expected winner, since resolveDeployEnv itself trusts
  // whatever the caller already merged.
  const rootEnv = { SSH_USER: "root-value" }
  const serverEnv = { SSH_USER: "server-value" }
  const merged = { ...rootEnv, ...serverEnv }
  assertEquals(merged.SSH_USER, "server-value")
})

const VALID_BASE = {
  SSH_ADDRESS: "root@example.com",
  // Must agree with SSH_ADDRESS's own user part ("root") — see the
  // SSH_USER/SSH_ADDRESS agreement tests below for the mismatch case.
  SSH_USER: "root",
  PATH_APPS: "/srv/apps",
  VOLUMES_PATH: "/srv/volumes",
  PUID: "1000",
  PGID: "1000",
  DOCKER_GROUP_ID: "988",
}

Deno.test("resolveDeployEnv: rejects an SSH_ADDRESS starting with -", () => {
  // -oProxyCommand=<cmd> runs <cmd> locally the moment ssh (or rsync,
  // which re-spawns ssh with the same target) parses it as an option.
  const err = assertThrows(
    () =>
      resolveDeployEnv(
        { ...VALID_BASE, SSH_ADDRESS: "-oProxyCommand=touch /tmp/PWNED" },
        "servers/home/.env",
        ROOT_ENV_PATH,
      ),
    UserError,
  )
  assertStringIncludes(err.message, "invalid SSH_ADDRESS")
})

Deno.test("resolveDeployEnv: accepts a plain user@host SSH_ADDRESS", () => {
  // Should not throw.
  resolveDeployEnv(VALID_BASE, "servers/home/.env", ROOT_ENV_PATH)
})

Deno.test("resolveDeployEnv: rejects a PATH_APPS containing $(...)", () => {
  const err = assertThrows(
    () =>
      resolveDeployEnv(
        { ...VALID_BASE, PATH_APPS: "/srv/apps/$(touch /tmp/PWNED)" },
        "servers/home/.env",
        ROOT_ENV_PATH,
      ),
    UserError,
  )
  assertStringIncludes(err.message, "invalid PATH_APPS")
})

Deno.test("resolveDeployEnv: rejects a VOLUMES_PATH with a .. segment", () => {
  const err = assertThrows(
    () =>
      resolveDeployEnv(
        { ...VALID_BASE, VOLUMES_PATH: "/srv/volumes/../../etc" },
        "servers/home/.env",
        ROOT_ENV_PATH,
      ),
    UserError,
  )
  assertStringIncludes(err.message, "invalid VOLUMES_PATH")
})

Deno.test("expandEnvRefs: ${VAR} expands against the given env", () => {
  assertEquals(
    expandEnvRefs("VOLUMES_PATH", "${PATH_APPS}/.volumes", { PATH_APPS: "/srv/apps" }),
    "/srv/apps/.volumes",
  )
})

Deno.test("expandEnvRefs: bare $VAR (no braces) also expands", () => {
  assertEquals(
    expandEnvRefs("VOLUMES_PATH", "$PATH_APPS/.volumes", { PATH_APPS: "/srv/apps" }),
    "/srv/apps/.volumes",
  )
})

Deno.test("expandEnvRefs: a value with no reference passes through unchanged", () => {
  assertEquals(
    expandEnvRefs("VOLUMES_PATH", "/srv/volumes", { PATH_APPS: "/srv/apps" }),
    "/srv/volumes",
  )
})

Deno.test("expandEnvRefs: throws a UserError naming an undefined reference", () => {
  const err = assertThrows(
    () => expandEnvRefs("VOLUMES_PATH", "${TYPO_PATH}/.volumes", { PATH_APPS: "/srv/apps" }),
    UserError,
  )
  assertStringIncludes(err.message, "invalid VOLUMES_PATH")
  assertStringIncludes(err.message, "TYPO_PATH")
})

Deno.test("resolveDeployEnv: VOLUMES_PATH=${PATH_APPS}/.volumes expands and passes validation (#223)", () => {
  const resolved = resolveDeployEnv(
    { ...VALID_BASE, PATH_APPS: "/srv/apps", VOLUMES_PATH: "${PATH_APPS}/.volumes" },
    "servers/home/.env",
    ROOT_ENV_PATH,
  )
  assertEquals(resolved.env.VOLUMES_PATH, "/srv/apps/.volumes")
})

Deno.test("resolveDeployEnv: VOLUMES_PATH=$PATH_APPS/.volumes (no braces) also expands (#223)", () => {
  const resolved = resolveDeployEnv(
    { ...VALID_BASE, PATH_APPS: "/srv/apps", VOLUMES_PATH: "$PATH_APPS/.volumes" },
    "servers/home/.env",
    ROOT_ENV_PATH,
  )
  assertEquals(resolved.env.VOLUMES_PATH, "/srv/apps/.volumes")
})

Deno.test("resolveDeployEnv: a VOLUMES_PATH referencing an undefined var still fails loudly", () => {
  const err = assertThrows(
    () =>
      resolveDeployEnv(
        { ...VALID_BASE, VOLUMES_PATH: "${TYPO_PATH}/.volumes" },
        "servers/home/.env",
        ROOT_ENV_PATH,
      ),
    UserError,
  )
  assertStringIncludes(err.message, "invalid VOLUMES_PATH")
  assertStringIncludes(err.message, "TYPO_PATH")
})

Deno.test("resolveDeployEnv: an expanded VOLUMES_PATH that still isn't absolute is rejected", () => {
  const err = assertThrows(
    () =>
      resolveDeployEnv(
        { ...VALID_BASE, PATH_APPS: "relative/apps", VOLUMES_PATH: "${PATH_APPS}/.volumes" },
        "servers/home/.env",
        ROOT_ENV_PATH,
      ),
    UserError,
  )
  assertStringIncludes(err.message, "invalid PATH_APPS")
})

Deno.test("resolveDeployEnv: rejects a SSH_ADDRESS user that disagrees with SSH_USER", () => {
  // A hook logs in as SSH_USER (cli/deploy/hooks.ts's contract key);
  // deploy's own ssh/rsync calls log in as SSH_ADDRESS's own user. If
  // they differ, a hook would silently reach a different account than
  // the rest of deploy.
  const err = assertThrows(
    () =>
      resolveDeployEnv(
        { ...VALID_BASE, SSH_ADDRESS: "root@example.com", SSH_USER: "deploy" },
        "servers/home/.env",
        ROOT_ENV_PATH,
      ),
    UserError,
  )
  assertStringIncludes(err.message, "root")
  assertStringIncludes(err.message, "deploy")
  assertStringIncludes(err.message, "servers/home/.env")
})

Deno.test("resolveDeployEnv: accepts a matching SSH_ADDRESS user and SSH_USER", () => {
  // Should not throw.
  resolveDeployEnv(
    { ...VALID_BASE, SSH_ADDRESS: "deploy@example.com", SSH_USER: "deploy" },
    "servers/home/.env",
    ROOT_ENV_PATH,
  )
})

Deno.test("resolveDeployEnv: a bare ssh_config alias (no user@) never conflicts with SSH_USER", () => {
  // Should not throw — nothing in SSH_ADDRESS to compare against.
  resolveDeployEnv(
    { ...VALID_BASE, SSH_ADDRESS: "home-alias", SSH_USER: "whoever" },
    "servers/home/.env",
    ROOT_ENV_PATH,
  )
})
