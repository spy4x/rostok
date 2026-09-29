// Stack metadata for `gitea`.
//
// Self-hosted Git service (Gitea + Postgres) at `git.${DOMAIN}`. Registration is closed and
// sign-in is required, so outgoing mail (sign-up confirmation, notifications) matters: the SMTP
// settings come from outside and have no default, except the submission port.

import type { StackMeta } from "@rostok/cli"
import { generatePassword } from "@rostok/cli"

export default {
  name: "gitea",
  description: "Self-hosted Git service (gitea/gitea + Postgres)",
  category: "devtools",
  requires: ["traefik"],
  variables: [
    {
      key: "GITEA_DOMAIN",
      question: "Public domain for Gitea?",
      default: "git.${DOMAIN}",
      required: true,
    },
    {
      key: "GITEA_DB_PASSWORD",
      question: "Postgres password (auto-generated)?",
      default: () => generatePassword(32),
      required: true,
      secret: true,
    },
    {
      key: "GITEA_SMTP_HOST",
      question: "SMTP server host for Gitea mail?",
      required: true,
    },
    {
      key: "GITEA_SMTP_PORT",
      question: "SMTP server port?",
      default: "587",
      required: true,
    },
    {
      key: "GITEA_SMTP_USERNAME",
      question: "SMTP username?",
      required: true,
    },
    {
      key: "GITEA_SMTP_PASSWORD",
      question: "SMTP password?",
      required: true,
      secret: true,
    },
    {
      key: "GITEA_SMTP_FROM",
      question: "From address of Gitea mail (e.g. Gitea <git@example.com>)?",
      required: true,
    },
  ],
} satisfies StackMeta
