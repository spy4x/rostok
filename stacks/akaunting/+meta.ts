// Stack metadata for `akaunting`.
//
// Self-hosted accounting (Akaunting + MariaDB) at `invoices.${DOMAIN}`, behind the
// `authelia@file` middleware. Both database passwords are generated at `stack add`;
// `generatePassword(32)` is URL-safe base64, so it needs no quoting in `.env`.

import type { StackMeta } from "@rostok/cli"
import { generatePassword } from "@rostok/cli"

export default {
  name: "akaunting",
  description: "Self-hosted accounting and invoicing (Akaunting + MariaDB)",
  category: "productivity",
  requires: ["traefik"],
  // MariaDB runs as its own user: deploy must not chown its folder to PUID:PGID (#312).
  keepOwner: ["akaunting/db"],
  variables: [
    {
      key: "AKAUNTING_DOMAIN",
      question: "Public domain for Akaunting?",
      default: "invoices.${DOMAIN}",
      required: true,
    },
    {
      key: "AKAUNTING_DB_ROOT_PASSWORD",
      question: "MariaDB root password (auto-generated)?",
      default: () => generatePassword(32),
      required: true,
      secret: true,
    },
    {
      key: "AKAUNTING_DB_PASSWORD",
      question: "MariaDB password of the akaunting user (auto-generated)?",
      default: () => generatePassword(32),
      required: true,
      secret: true,
    },
  ],
} satisfies StackMeta
