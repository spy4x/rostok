// Stack metadata for `email-mcp`.
//
// mcp-email-server (IMAP + SMTP) over Streamable HTTP. Internal only: no Traefik route, so no
// domain and no `requires: ["traefik"]`. Other containers on the `proxy` network reach it as
// `http://hl-email-mcp:9557/mcp`.
//
// compose.yml reads none of these keys: `before.deploy.ts` renders them into
// `stacks/email-mcp/config.toml`, which the container mounts. One account is required, a second
// is optional. Passwords come from outside, so they have no default: `stack add` asks for them.
//
// EMAIL_MCP_VERIFY_SSL defaults to `false` because the default host is the server's own mail
// stack, often behind a certificate the container does not trust. Set `true` for an external
// mail host.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "email-mcp",
  description: "Email MCP server (IMAP and SMTP) for AI assistants (ai-zerolab/mcp-email-server)",
  category: "ai",
  variables: [
    {
      key: "EMAIL_MCP_HOST",
      question: "Mail server host for IMAP (port 993) and SMTP (port 587)?",
      default: "mail.${DOMAIN}",
      required: true,
    },
    {
      key: "EMAIL_MCP_USER",
      question: "Login and address of the first mail account?",
      required: true,
    },
    {
      key: "EMAIL_MCP_PASSWORD",
      question: "Password of the first mail account?",
      required: true,
      secret: true,
    },
    {
      key: "EMAIL_MCP_FULL_NAME",
      question: "Display name for the first account? Leave blank to use the address",
      required: false,
    },
    {
      key: "EMAIL_MCP_ACCOUNT_NAME",
      question: "Name the assistant sees for the first account?",
      default: "main",
      required: true,
    },
    {
      key: "EMAIL_MCP_USER_2",
      question: "Login and address of a second mail account? Leave blank to skip",
      required: false,
    },
    {
      key: "EMAIL_MCP_PASSWORD_2",
      question: "Password of the second mail account?",
      required: false,
      secret: true,
    },
    {
      key: "EMAIL_MCP_FULL_NAME_2",
      question: "Display name for the second account? Leave blank to use its address",
      required: false,
    },
    {
      key: "EMAIL_MCP_ACCOUNT_NAME_2",
      question: "Name the assistant sees for the second account?",
      default: "second",
      required: true,
    },
    {
      key: "EMAIL_MCP_VERIFY_SSL",
      question: "Verify the mail server's TLS certificate (true or false)?",
      default: "false",
      required: true,
    },
  ],
} satisfies StackMeta
