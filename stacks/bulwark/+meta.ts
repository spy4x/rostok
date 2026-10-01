// Stack metadata for `bulwark`.
//
// Bulwark is a JMAP webmail client. It logs users in against the Stalwart mail server at
// `mail.${DOMAIN}` (see the `stalwart` stack) and is served at `webmail.${DOMAIN}` by default, behind Traefik.
//
// Variable shape:
//   - BULWARK_DOMAIN: single var, default `webmail.${DOMAIN}`. The JMAP server URL stays
//     `https://mail.${DOMAIN}`, where the `stalwart` stack of the same server puts it.
//   - BULWARK_ADMIN_PASSWORD: password of the setup wizard and admin dashboard. Generated.
//   - BULWARK_SESSION_SECRET: signs admin session cookies. Generated.
//
// Server-level vars (PROJECT, DOMAIN, VOLUMES_PATH) intentionally NOT declared here.

import type { StackMeta } from "@rostok/cli"
import { generatePassword } from "@rostok/cli"

export default {
  name: "bulwark",
  description: "Modern JMAP webmail client for the Stalwart mail server",
  category: "productivity",
  requires: ["traefik"],
  // The image runs as uid 1001 (nextjs): deploy must not chown its data folders to PUID:PGID.
  keepOwner: ["bulwark/settings", "bulwark/admin", "bulwark/admin-state", "bulwark/telemetry"],
  variables: [
    {
      key: "BULWARK_DOMAIN",
      question: "Public domain for Bulwark webmail?",
      default: "webmail.${DOMAIN}",
      required: true,
    },
    {
      key: "BULWARK_ADMIN_PASSWORD",
      question: "Admin password for the Bulwark setup wizard?",
      default: () => generatePassword(24),
      required: true,
      secret: true,
    },
    {
      key: "BULWARK_SESSION_SECRET",
      question: "Secret for signing admin session cookies?",
      default: () => generatePassword(48),
      required: true,
      secret: true,
    },
  ],
} satisfies StackMeta
