import { assert, assertEquals, assertFalse, assertStringIncludes, assertThrows } from "@std/assert"
import { join, resolve } from "@std/path"
import { UserError } from "./errors.ts"
import {
  DEPLOY_REQUIRED_KEYS,
  hasReservedStackKeyPrefix,
  isServerKey,
  normalizeRemotePath,
  parseSshAddress,
  pathComponents,
  pathsNestedOrEqual,
  rsyncDestination,
  rsyncSshOption,
  SERVER_KEYS,
  serverDirFor,
  sshArgs,
  stackKeyPrefix,
  validateRemotePath,
  validateServerName,
  validateSshAddress,
  validateSshUser,
} from "./server-keys.ts"
import { SSH_ADDRESS_TEST_CASES } from "./deploy/ssh-address-test-cases.ts"

Deno.test("accepts ordinary server names", () => {
  for (const name of ["home", "cloud-1", "a", "0", "x".repeat(63)]) {
    validateServerName(name)
  }
})

Deno.test("rejects names that escape servers/ or break shell commands", () => {
  const bad = [
    "",
    ".",
    "..",
    "../x",
    "../../escaped",
    "a/b",
    "/etc",
    "home.",
    "-home",
    "Home",
    "home server",
    "home;rm",
    "x".repeat(64),
  ]
  for (const name of bad) {
    assertThrows(() => validateServerName(name), UserError, "invalid server name")
  }
})

Deno.test("serverDirFor returns the folder under servers/", () => {
  assertEquals(serverDirFor("/p", "home"), join(resolve("/p"), "servers", "home"))
})

Deno.test("serverDirFor refuses path traversal", () => {
  assertThrows(() => serverDirFor("/p", "../x"), UserError)
})

Deno.test("deploy only requires keys that server create writes", () => {
  for (const key of DEPLOY_REQUIRED_KEYS) {
    assert((SERVER_KEYS as readonly string[]).includes(key), key)
  }
})

Deno.test("isServerKey covers SERVER_KEYS and PATH_*", () => {
  assert(isServerKey("DOMAIN"))
  assert(isServerKey("PATH_MEDIA"))
  assertFalse(isServerKey("LIBRESPEED_IMAGE_TAG"))
  assertFalse(isServerKey("USER"))
})

Deno.test("stackKeyPrefix uppercases and replaces dashes", () => {
  assertEquals(stackKeyPrefix("librespeed"), "LIBRESPEED_")
  assertEquals(stackKeyPrefix("deepseek-harness"), "DEEPSEEK_HARNESS_")
})

Deno.test("hasReservedStackKeyPrefix flags a stack whose own prefix collides with a reserved name", () => {
  for (
    const name of [
      "git",
      "docker",
      "ssh",
      "bash-tools",
      "sudo-helper",
      "npm-mirror",
      "jsr",
      "rust-tools",
    ]
  ) {
    assert(hasReservedStackKeyPrefix(name), name)
  }
  assertFalse(hasReservedStackKeyPrefix("gitea")) // "GITEA_" doesn't start with "GIT_"
  assertFalse(hasReservedStackKeyPrefix("librespeed"))
})

Deno.test("hasReservedStackKeyPrefix exempts the two pre-existing docker-* catalog stacks", () => {
  assertFalse(hasReservedStackKeyPrefix("docker-registry"))
  assertFalse(hasReservedStackKeyPrefix("docker-sock-proxy"))
})

Deno.test("accepts ordinary SSH targets", () => {
  for (
    const v of [
      "homelab",
      "192.0.2.1",
      "root@192.0.2.1",
      "deploy@host.example.com",
      "2001:db8::1",
      "my_alias",
    ]
  ) {
    validateSshAddress(v)
  }
})

Deno.test("rejects SSH targets that ssh would read as options", () => {
  for (
    const v of [
      "",
      "-oProxyCommand=touch x",
      "-p",
      "root@host x",
      "host\n",
      "a\tb",
      "h;id",
      "$(id)",
    ]
  ) {
    assertThrows(() => validateSshAddress(v), UserError, "invalid SSH_ADDRESS")
  }
})

Deno.test("parseSshAddress parses user, host and port", () => {
  assertEquals(parseSshAddress("homelab"), { user: undefined, host: "homelab", port: undefined })
  assertEquals(parseSshAddress("192.0.2.1"), {
    user: undefined,
    host: "192.0.2.1",
    port: undefined,
  })
  assertEquals(parseSshAddress("root@192.0.2.1"), {
    user: "root",
    host: "192.0.2.1",
    port: undefined,
  })
  assertEquals(parseSshAddress("192.0.2.1:2222"), {
    user: undefined,
    host: "192.0.2.1",
    port: 2222,
  })
  assertEquals(parseSshAddress("root@192.0.2.1:2222"), {
    user: "root",
    host: "192.0.2.1",
    port: 2222,
  })
})

Deno.test("parseSshAddress accepts a bare IPv6 address with no port", () => {
  assertEquals(parseSshAddress("2001:db8::1"), {
    user: undefined,
    host: "2001:db8::1",
    port: undefined,
  })
  assertEquals(parseSshAddress("root@2001:db8::1"), {
    user: "root",
    host: "2001:db8::1",
    port: undefined,
  })
})

Deno.test("parseSshAddress accepts [IPv6]:port, bracketed with or without a user", () => {
  assertEquals(parseSshAddress("[2001:db8::1]:2222"), {
    user: undefined,
    host: "2001:db8::1",
    port: 2222,
  })
  assertEquals(parseSshAddress("root@[2001:db8::1]:2222"), {
    user: "root",
    host: "2001:db8::1",
    port: 2222,
  })
  // Brackets with no port are also fine.
  assertEquals(parseSshAddress("[2001:db8::1]"), {
    user: undefined,
    host: "2001:db8::1",
    port: undefined,
  })
})

Deno.test("rejects an unbracketed IPv6 address followed by what looks like a port", () => {
  assertThrows(
    () => parseSshAddress("2001:db8::1:2222"),
    UserError,
    "bracket an IPv6 address that carries a port",
  )
})

Deno.test('rejects root@host:22:33 instead of reading it as a host literally named "host:22:33" (#236)', () => {
  // Before this fix, a multi-colon address with no "::" fell straight
  // through to `host = rest` whenever it wasn't flagged as an ambiguous
  // IPv6-with-port — accepting "host:22:33" as one literal SSH_HOST
  // (colons are in SSH_HOST_CHARS_PATTERN's own alphabet). ssh then
  // failed with its own "could not resolve hostname" instead of
  // rostok's own message.
  const err = assertThrows(
    () => parseSshAddress("root@host:22:33"),
    UserError,
    "invalid SSH_ADDRESS",
  )
  assertStringIncludes(err.message, "more than one colon")
})

Deno.test("still accepts a genuine unbracketed IPv6 literal with no port", () => {
  // "host:22:33" is rejected above because "host:22" has letters outside
  // a-f; a real (rare) fully-written IPv6 literal, whose groups are all
  // hex digits and colons, must keep parsing as a bare host.
  assertEquals(parseSshAddress("2001:0db8:0000:0000:0000:0000:0000:0001"), {
    user: undefined,
    host: "2001:0db8:0000:0000:0000:0000:0000:0001",
    port: undefined,
  })
})

Deno.test('rejects "cafe:22:33" and "root@deadbeef:22:33" — every char is hex, but 3 groups isn\'t real IPv6 (review round)', () => {
  // A "looks hex" check alone (HEX_COLON_PATTERN on the pre-port slice)
  // wrongly accepted these: "cafe"/"deadbeef" ARE valid hex, so the old
  // heuristic mistook them for the rare-full-IPv6-literal case instead
  // of requiring the real shape (exactly 8 groups, or "::").
  for (const input of ["cafe:22:33", "root@deadbeef:22:33"]) {
    const err = assertThrows(() => parseSshAddress(input), UserError, "invalid SSH_ADDRESS")
    assertStringIncludes(err.message, "more than one colon")
  }
})

Deno.test("rejects a port outside 1-65535", () => {
  for (
    const v of ["host:0", "host:65536", "host:999999", "[2001:db8::1]:0", "[2001:db8::1]:70000"]
  ) {
    assertThrows(() => parseSshAddress(v), UserError, "outside 1-65535")
  }
})

Deno.test("rejects a non-numeric or empty port", () => {
  for (const v of ["host:abc", "host:", "[2001:db8::1]:"]) {
    assertThrows(() => parseSshAddress(v), UserError, "invalid SSH_ADDRESS")
  }
})

Deno.test("strips control characters from a rejected SSH_ADDRESS before it reaches the error message (#7)", () => {
  const err = assertThrows(
    () => parseSshAddress("host\x07\x1bwith\x00control"),
    UserError,
  )
  assertEquals(err.message.includes("\x07"), false)
  assertEquals(err.message.includes("\x1b"), false)
  assertEquals(err.message.includes("\x00"), false)
  assertStringIncludes(err.message, "hostwithcontrol")
})

Deno.test("rejects empty parts", () => {
  for (const v of ["@host", "user@", ":2222"]) {
    assertThrows(() => parseSshAddress(v), UserError, "invalid SSH_ADDRESS")
  }
})

Deno.test("rejects an unsafe or malformed user", () => {
  for (
    const v of ["ro ot@host", "$(id)@host", "`id`@host", "us'er@host", "root:x@host"]
  ) {
    assertThrows(() => parseSshAddress(v), UserError, "invalid SSH_ADDRESS")
  }
})

Deno.test("rejects a host starting with -, with or without a user", () => {
  for (const v of ["root@-A", "user@-oProxyCommand"]) {
    assertThrows(() => parseSshAddress(v), UserError, "invalid SSH_ADDRESS")
  }
})

// #229: traefik and gatus no longer carry their own inlined SSH_ADDRESS
// parser — every hook now gets SSH_HOST/SSH_PORT/SSH_USER as contract
// keys, already parsed once by cli/deploy/hooks.ts's buildHookEnv (see
// its module comment). SSH_ADDRESS_TEST_CASES stays in use below,
// proving parseSshAddress itself handles every case in that shared
// table; buildHookEnv's own use of it is covered by
// cli/deploy/hooks.test.ts.
Deno.test("parseSshAddress agrees with every case in the shared SSH_ADDRESS test table", () => {
  for (const { input, expected } of SSH_ADDRESS_TEST_CASES) {
    if (expected === undefined) {
      assertThrows(() => parseSshAddress(input), Error, undefined, `should reject "${input}"`)
    } else {
      assertEquals(
        parseSshAddress(input),
        { user: undefined, port: undefined, ...expected },
        `disagrees on "${input}"`,
      )
    }
  }
})

Deno.test("sshArgs builds -p, the standard options, -- and the target", () => {
  assertEquals(
    sshArgs({ host: "192.0.2.1" }, ["id", "-u"]),
    ["-o", "ConnectTimeout=10", "--", "192.0.2.1", "id", "-u"],
  )
  assertEquals(
    sshArgs({ user: "root", host: "192.0.2.1", port: 2222 }, ["id", "-u"]),
    ["-o", "ConnectTimeout=10", "-p", "2222", "--", "root@192.0.2.1", "id", "-u"],
  )
  assertEquals(
    sshArgs({ host: "2001:db8::1", port: 2222 }, [], { batchMode: true }),
    ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", "-p", "2222", "--", "2001:db8::1"],
  )
})

Deno.test("rsyncSshOption and rsyncDestination carry the port and bracket a bare IPv6", () => {
  assertEquals(
    rsyncSshOption({ host: "192.0.2.1", port: 2222 }),
    "ssh -o ConnectTimeout=10 -p 2222",
  )
  assertEquals(
    rsyncDestination({ host: "192.0.2.1", port: 2222 }, "/srv/apps"),
    "192.0.2.1:/srv/apps",
  )
  assertEquals(
    rsyncDestination({ user: "root", host: "2001:db8::1" }, "/srv/apps"),
    "root@[2001:db8::1]:/srv/apps",
  )
})

Deno.test("accepts plain absolute remote paths, two components or deeper", () => {
  for (const v of ["/srv/apps", "/home/deploy/apps_1", "/srv/v-1.2"]) {
    validateRemotePath("PATH_APPS", v)
  }
})

Deno.test("rejects remote paths with shell metacharacters or ..", () => {
  for (
    const v of ["srv/apps", "/srv/$(touch x)", "/srv/a;b", "/srv/a b", "/srv/../etc", "~/apps"]
  ) {
    assertThrows(() => validateRemotePath("PATH_APPS", v), UserError, "invalid PATH_APPS")
  }
})

Deno.test("rejects / and any one-component path — rostok must own the whole directory (#233)", () => {
  // /srv or /home as PATH_APPS would make a full deploy's rsync --delete
  // (run-deploy.ts) delete everything ELSE already on the server under
  // that path, not just what rostok put there.
  for (const v of ["/", "/srv", "/home", "/apps"]) {
    assertThrows(() => validateRemotePath("PATH_APPS", v), UserError, "must be a directory")
  }
})

Deno.test('pathComponents: splits a path into its non-empty, non-"." components', () => {
  assertEquals(pathComponents("/srv/apps"), ["srv", "apps"])
  assertEquals(pathComponents("/srv//apps/"), ["srv", "apps"])
  assertEquals(pathComponents("/srv/./apps"), ["srv", "apps"])
  assertEquals(pathComponents("/"), [])
})

Deno.test("normalizeRemotePath: collapses doubled slashes, a trailing slash and . segments", () => {
  assertEquals(normalizeRemotePath("/srv/apps"), "/srv/apps")
  assertEquals(normalizeRemotePath("/srv/apps/"), "/srv/apps")
  assertEquals(normalizeRemotePath("/srv//apps"), "/srv/apps")
  assertEquals(normalizeRemotePath("/srv/./apps"), "/srv/apps")
})

Deno.test("accepts plain ssh/system usernames", () => {
  for (const v of ["root", "deploy", "deploy-1", "deploy.user", "_svc", "a"]) {
    validateSshUser(v)
  }
})

Deno.test("rejects an SSH_USER with shell metacharacters, spaces or a colon", () => {
  // These reach an unquoted remote shell command a hook builds by hand
  // (e.g. syncthing's `chown ${user}:${user} <path>`) — a bare
  // ssh_config alias SSH_ADDRESS has no user@ part for parseSshAddress
  // to validate on its own, so this is the only check SSH_USER gets.
  for (
    const v of ["x $HOME", "root; rm -rf /", "root:x", "$(id)", "`id`", "us'er", "", "-oProxy"]
  ) {
    assertThrows(() => validateSshUser(v), UserError, "invalid SSH_USER")
  }
})

Deno.test("pathsNestedOrEqual: a sibling directory is not nested (#233)", () => {
  assertFalse(pathsNestedOrEqual("/srv/apps", "/srv/volumes"))
  // A raw string-prefix check would wrongly flag this pair — "/srv/apps2"
  // starts with the literal text "/srv/apps" but is a sibling directory.
  assertFalse(pathsNestedOrEqual("/srv/apps", "/srv/apps2"))
})

Deno.test("pathsNestedOrEqual: VOLUMES_PATH inside PATH_APPS is nested, either argument order", () => {
  assert(pathsNestedOrEqual("/srv/apps", "/srv/apps/.volumes"))
  assert(pathsNestedOrEqual("/srv/apps/.volumes", "/srv/apps"))
})

Deno.test("pathsNestedOrEqual: PATH_APPS inside VOLUMES_PATH is nested too", () => {
  assert(pathsNestedOrEqual("/srv/volumes/apps", "/srv/volumes"))
})

Deno.test("pathsNestedOrEqual: equal paths count as nested", () => {
  assert(pathsNestedOrEqual("/srv/apps", "/srv/apps"))
})

Deno.test("pathsNestedOrEqual: normalises trailing slashes, doubled slashes and . segments before comparing", () => {
  assert(pathsNestedOrEqual("/srv/apps/", "/srv//apps"))
  assert(pathsNestedOrEqual("/srv/./apps", "/srv/apps"))
  assert(pathsNestedOrEqual("/srv/apps/", "/srv/apps/.volumes"))
})
