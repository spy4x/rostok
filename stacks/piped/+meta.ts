// Stack metadata for `piped`.
//
// Privacy-friendly YouTube front end: frontend, API, proxy, PoToken helper and a Postgres
// database. Three hosts behind Traefik (`piped.`, `pipedapi.`, `pipedproxy.` + `${DOMAIN}`),
// so the stack requires it. `before.deploy.ts` renders `config.properties` from the template
// with the database variables below.
//
// Variable shape:
//   - PIPED_DB_NAME / PIPED_DB_USER: default `piped`.
//   - PIPED_DB_PASSWORD: secret, generated at `stack add`. `generatePassword` is URL-safe
//     base64, so it needs no escaping in the JDBC settings the template writes.
//
// Server-level vars (DOMAIN, VOLUMES_PATH) intentionally NOT declared here.

import type { StackMeta } from "@rostok/cli"
import { generatePassword } from "@rostok/cli"

export default {
  name: "piped",
  description: "Privacy-friendly YouTube front end (TeamPiped/Piped)",
  category: "media",
  requires: ["traefik"],
  variables: [
    {
      key: "PIPED_DB_NAME",
      question: "Postgres database name?",
      default: "piped",
      required: true,
    },
    {
      key: "PIPED_DB_USER",
      question: "Postgres user?",
      default: "piped",
      required: true,
    },
    {
      key: "PIPED_DB_PASSWORD",
      question: "Postgres password (auto-generated)?",
      default: () => generatePassword(32),
      required: true,
      secret: true,
    },
  ],
} satisfies StackMeta
