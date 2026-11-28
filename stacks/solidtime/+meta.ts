// Stack metadata for `solidtime`.
//
// solidtime time tracker (web app, scheduler, queue worker, Gotenberg for PDFs, PostgreSQL) at
// `time.${DOMAIN}`. It has its own sign-in, and its desktop app calls the API, so no Authelia.
// The database password and Laravel's APP_KEY are generated at `stack add`. The OAuth key pair
// needs no variable: the web container creates it in its storage folder on first start.
//
// The SMTP variables are optional: with the default `log` mailer, mail goes to the container log.

import type { StackMeta } from "@rostok/cli"
import { generatePassword } from "@rostok/cli"

/** A Laravel APP_KEY for the AES-256 cipher: `base64:` and 32 random bytes in standard base64. */
export function generateAppKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return `base64:${btoa(String.fromCharCode(...bytes))}`
}

export default {
  name: "solidtime",
  description: "Time tracker with projects, clients, reports and a desktop app (solidtime)",
  category: "productivity",
  requires: ["traefik"],
  // Postgres runs as its own user: deploy must not chown the folder to PUID:PGID.
  keepOwner: ["solidtime/postgres"],
  // The solidtime image runs as uid 1000, whatever PUID is.
  owner: { "solidtime/storage": "1000:1000" },
  variables: [
    {
      key: "SOLIDTIME_IMAGE_TAG",
      default: "latest",
      required: false,
    },
    {
      key: "SOLIDTIME_DB_IMAGE_TAG",
      default: "18-alpine",
      required: false,
    },
    {
      key: "SOLIDTIME_GOTENBERG_IMAGE_TAG",
      default: "8",
      required: false,
    },
    {
      key: "SOLIDTIME_DOMAIN",
      question: "Public domain for solidtime?",
      default: "time.${DOMAIN}",
      required: true,
    },
    {
      key: "SOLIDTIME_DB_PASSWORD",
      default: () => generatePassword(32),
      required: true,
      secret: true,
    },
    {
      key: "SOLIDTIME_APP_KEY",
      default: generateAppKey,
      required: true,
      secret: true,
    },
    {
      key: "SOLIDTIME_SUPER_ADMINS",
      question: "E-mail addresses that may open /admin, comma-separated? Leave blank to skip",
      required: false,
    },
    {
      key: "SOLIDTIME_MAIL_MAILER",
      question: "Mailer: log (write mails to the container log) or smtp?",
      default: "log",
      required: false,
    },
    {
      key: "SOLIDTIME_MAIL_HOST",
      question: "SMTP host? Leave blank to skip",
      required: false,
    },
    {
      key: "SOLIDTIME_MAIL_PORT",
      question: "SMTP port?",
      default: "587",
      required: false,
    },
    {
      key: "SOLIDTIME_MAIL_ENCRYPTION",
      question: "SMTP encryption (tls or ssl)?",
      default: "tls",
      required: false,
    },
    {
      key: "SOLIDTIME_MAIL_USERNAME",
      question: "SMTP username? Leave blank to skip",
      required: false,
    },
    {
      key: "SOLIDTIME_MAIL_PASSWORD",
      question: "SMTP password? Leave blank to skip",
      required: false,
      secret: true,
    },
    {
      key: "SOLIDTIME_MAIL_FROM_ADDRESS",
      question: "From address for mails? Leave blank for noreply@<your domain>",
      required: false,
    },
  ],
} satisfies StackMeta
