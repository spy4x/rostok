// A single table of SSH_ADDRESS inputs, shared by cli/server-keys.test.ts
// and the traefik/gatus after.deploy.test.ts files, so the cli parser
// and each hook's inlined copy are proven to agree on every case in one
// place instead of three independently-maintained lists that can drift.
// Dev-only: nothing under `stacks/` imports this at runtime, so it never
// ships — only the two hooks' own inlined parseSshAddress does.

export interface SshAddressCase {
  input: string
  /** The expected parse result, or undefined if every parser must reject `input`. */
  expected?: { user?: string; host: string; port?: number }
}

export const SSH_ADDRESS_TEST_CASES: SshAddressCase[] = [
  // Accepted.
  { input: "homelab", expected: { host: "homelab" } },
  { input: "192.0.2.1", expected: { host: "192.0.2.1" } },
  { input: "root@192.0.2.1", expected: { user: "root", host: "192.0.2.1" } },
  { input: "deploy@host.example.com", expected: { user: "deploy", host: "host.example.com" } },
  { input: "root@192.0.2.1:2222", expected: { user: "root", host: "192.0.2.1", port: 2222 } },
  { input: "2001:db8::1", expected: { host: "2001:db8::1" } },
  { input: "root@2001:db8::1", expected: { user: "root", host: "2001:db8::1" } },
  { input: "[2001:db8::1]:2222", expected: { host: "2001:db8::1", port: 2222 } },
  {
    input: "root@[2001:db8::1]:2222",
    expected: { user: "root", host: "2001:db8::1", port: 2222 },
  },
  { input: "[2001:db8::1]", expected: { host: "2001:db8::1" } },
  { input: "my_alias", expected: { host: "my_alias" } },

  // Rejected: empty/malformed structure.
  { input: "" },
  { input: "@host" },
  { input: "user@" },
  { input: ":2222" },

  // Rejected: a leading "-" would be read as an ssh option.
  { input: "-oProxyCommand=touch x" },
  { input: "-p" },
  { input: "root@-A" },
  { input: "user@-oProxyCommand" },

  // Rejected: an unsafe or malformed user.
  { input: "ro ot@host" },
  { input: "$(id)@host" },
  { input: "`id`@host" },
  { input: "us'er@host" },
  { input: "root:x@host" },

  // Rejected: whitespace/control characters, or a shell-metacharacter host.
  { input: "root@host x" },
  { input: "host\n" },
  { input: "root@host\n" },
  { input: "a\tb" },
  { input: "h;id" },
  { input: "$(id)" },

  // Rejected: bad ports.
  { input: "host:0" },
  { input: "host:65536" },
  { input: "host:abc" },
  { input: "host:" },
  { input: "[2001:db8::1]:0" },
  { input: "[2001:db8::1]:" },

  // Rejected: an unbracketed IPv6 address followed by what looks like a port.
  { input: "2001:db8::1:2222" },
]
