// Stack metadata for `caldiy`.
//
// Cal.diy is the community edition of Cal.com, a scheduling platform, served at
// `schedule.${DOMAIN}` behind Traefik. The stack runs the app, PostgreSQL, Redis and a small
// cron container that polls Cal.com's workflow endpoints.
//
// Variable shape:
//   - CALDIY_DOMAIN: single var, default `schedule.${DOMAIN}`; also the app's own URL.
//   - CALDIY_DB_PASSWORD: embedded in the database URL, so it must be URL-safe. The generated
//     value is (`A-Z a-z 0-9 - _`).
//   - CALDIY_NEXTAUTH_SECRET, CALDIY_ENCRYPTION_KEY, CALDIY_CRON_API_KEY: generated secrets.
//   - CALDIY_SMTP_*: outgoing mail. The defaults point at the `stalwart` stack of the same
//     server (`mail.${DOMAIN}`, submission port 587) and a `noreply@${DOMAIN}` mailbox the
//     operator creates there. The password has no default: mail stays off until it is set.
//
// Server-level vars (PROJECT, DOMAIN, TIMEZONE, VOLUMES_PATH) intentionally NOT declared here.

import type { StackMeta } from "@rostok/cli"
import { generatePassword } from "@rostok/cli"

export default {
  name: "caldiy",
  description: "Cal.diy scheduling platform (community edition of Cal.com)",
  category: "productivity",
  requires: ["traefik"],
  variables: [
    {
      key: "CALDIY_DOMAIN",
      question: "Public domain for Cal.diy?",
      default: "schedule.${DOMAIN}",
      required: true,
    },
    {
      key: "CALDIY_VERSION",
      default: "latest",
      required: false,
    },
    {
      key: "CALDIY_DB_PASSWORD",
      question: "PostgreSQL password for Cal.diy (URL-safe characters only)?",
      default: () => generatePassword(32),
      required: true,
      secret: true,
    },
    {
      key: "CALDIY_NEXTAUTH_SECRET",
      question: "NextAuth session secret?",
      default: () => generatePassword(48),
      required: true,
      secret: true,
    },
    {
      key: "CALDIY_ENCRYPTION_KEY",
      question: "Key for encrypting stored calendar credentials?",
      default: () => generatePassword(32),
      required: true,
      secret: true,
    },
    {
      key: "CALDIY_CRON_API_KEY",
      question: "Shared secret for the cron endpoints?",
      default: () => generatePassword(32),
      required: true,
      secret: true,
    },
    {
      key: "CALDIY_SMTP_HOST",
      question: "SMTP host for outgoing mail?",
      default: "mail.${DOMAIN}",
      required: true,
    },
    {
      key: "CALDIY_SMTP_PORT",
      question: "SMTP submission port (STARTTLS)?",
      default: "587",
      required: true,
    },
    {
      key: "CALDIY_SMTP_FROM",
      question: "From address for outgoing mail?",
      default: "noreply@${DOMAIN}",
      required: true,
    },
    {
      key: "CALDIY_SMTP_USERNAME",
      question: "SMTP username?",
      default: "noreply@${DOMAIN}",
      required: true,
    },
    {
      key: "CALDIY_SMTP_PASSWORD",
      question: "SMTP password? Leave blank to skip (no outgoing mail until it is set)",
      required: false,
      secret: true,
    },
  ],
} satisfies StackMeta
