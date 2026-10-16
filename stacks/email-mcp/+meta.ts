// Stack metadata for `email-mcp`.
//
// mcp-email-server (IMAP + SMTP) over Streamable HTTP, behind a guard (guard/) that asks for a
// token and passes only allowed tools (spy4x/rostok#143). Internal only: no Traefik route, so no
// domain and no `requires: ["traefik"]`. Only Open WebUI reaches the guard, as
// `http://hl-email-mcp:9557/mcp` on this stack's own `hl-email-mcp` network.
//
// EMAIL_MCP_TOKEN is the bearer token the guard asks for, generated at `stack add`. open-webui
// sends it through its own OPEN_WEBUI_EMAIL_MCP_TOKEN, set to `${EMAIL_MCP_TOKEN}`.
// EMAIL_MCP_ALLOWED_USERS lists the Open WebUI accounts (their e-mail addresses) that may send,
// move, archive or mark mail; everyone else who can use the tools may only read.
//
// compose.yml reads only EMAIL_MCP_IMAGE_TAG and the two guard keys: `before.deploy.ts` renders
// the other keys into `stacks/email-mcp/config.toml`, which the upstream container mounts. One
// account is required, a second is optional. Passwords come from outside, so they have no default: `stack add` asks for them.
//
// The mail server's TLS certificate is always verified (#143), so there is no key for it: the
// host must present a certificate the container trusts for the name in EMAIL_MCP_HOST.

import type { StackMeta } from "@rostok/cli"
import { generatePassword } from "@rostok/cli"

export default {
  name: "email-mcp",
  description: "Email MCP server (IMAP and SMTP) for AI assistants (ai-zerolab/mcp-email-server)",
  category: "ai",
  variables: [
    {
      key: "EMAIL_MCP_IMAGE_TAG",
      default: "latest",
      required: false,
    },
    {
      key: "EMAIL_MCP_TOKEN",
      question: "Bearer token Open WebUI sends to the mail tools (auto-generated)?",
      default: () => generatePassword(32),
      required: true,
      secret: true,
    },
    {
      key: "EMAIL_MCP_ALLOWED_USERS",
      question:
        "Open WebUI accounts (e-mail addresses, comma-separated) that may send and move mail? Leave blank for read-only",
      required: false,
    },
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
  ],
} satisfies StackMeta
