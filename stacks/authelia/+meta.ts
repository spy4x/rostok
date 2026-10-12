// Stack metadata for `authelia`.
//
// Authelia is the single sign-on portal at `auth.${DOMAIN}`, with a Redis container for its
// sessions. Its two config files are written at deploy by `before.deploy.ts` (see there), unless
// the server keeps its own in `servers/<server>/configs/authelia/`.
//
// Variable shape:
//   - AUTHELIA_DOMAIN: the portal's host, default `auth.${DOMAIN}`. The session cookie is set
//     for DOMAIN, so the host must be DOMAIN itself or below it.
//   - AUTHELIA_SESSION_SECRET, AUTHELIA_STORAGE_ENCRYPTION_KEY,
//     AUTHELIA_IDENTITY_VALIDATION_RESET_PASSWORD_JWT_SECRET: generated, each its own value.
//     These are Authelia's own environment variable names: compose.yml passes them through, and
//     they never appear in configuration.yml. The storage key encrypts the database: changing
//     it on a server that already has one stops Authelia from starting.
//   - AUTHELIA_ADMIN_USER, AUTHELIA_ADMIN_EMAIL, AUTHELIA_ADMIN_PASSWORD: the first user of the
//     generated users.yml. The password is generated; read it from the server's `.env`.
//   - AUTHELIA_SMTP_*: optional. With an address and a sender, Authelia sends mail and password
//     reset is switched on; without them reset is off and codes go to a file on the server.
//
// Only what compose.yml lists reaches the container, under Authelia's own variable names.
//
// Server-level vars (PROJECT, DOMAIN, TIMEZONE, VOLUMES_PATH, PATH_APPS) intentionally NOT
// declared here.

import type { StackMeta } from "@rostok/cli"
import { generatePassword } from "@rostok/cli"

export default {
  name: "authelia",
  description: "Single sign-on portal (Authelia) for services behind Traefik",
  category: "auth",
  requires: ["traefik"],
  variables: [
    {
      key: "AUTHELIA_DOMAIN",
      question: "Public domain for the sign-in page?",
      default: "auth.${DOMAIN}",
      required: true,
    },
    {
      key: "AUTHELIA_SESSION_SECRET",
      question: "Secret that protects Authelia's session data?",
      default: () => generatePassword(64),
      required: true,
      secret: true,
    },
    {
      key: "AUTHELIA_STORAGE_ENCRYPTION_KEY",
      question: "Key that encrypts Authelia's database?",
      default: () => generatePassword(64),
      required: true,
      secret: true,
    },
    {
      key: "AUTHELIA_IDENTITY_VALIDATION_RESET_PASSWORD_JWT_SECRET",
      question: "Secret that signs Authelia's password reset links?",
      default: () => generatePassword(64),
      required: true,
      secret: true,
    },
    {
      key: "AUTHELIA_ADMIN_USER",
      question: "Name of the first user?",
      default: "admin",
      required: true,
    },
    {
      key: "AUTHELIA_ADMIN_EMAIL",
      question: "Email address of the first user?",
      default: "admin@${DOMAIN}",
      required: true,
    },
    {
      key: "AUTHELIA_ADMIN_PASSWORD",
      question: "Password of the first user?",
      default: () => generatePassword(32),
      required: true,
      secret: true,
    },
    {
      key: "AUTHELIA_SMTP_ADDRESS",
      question:
        "SMTP server for Authelia's mail (e.g. submission://smtp.example.com:587)? Leave blank to skip",
      required: false,
    },
    {
      key: "AUTHELIA_SMTP_SENDER",
      question: "Sender of Authelia's mail (e.g. Authelia <auth@example.com>)? Leave blank to skip",
      required: false,
    },
    {
      key: "AUTHELIA_SMTP_USERNAME",
      question: "SMTP user name? Leave blank to skip",
      required: false,
    },
    {
      key: "AUTHELIA_SMTP_PASSWORD",
      question: "SMTP password? Leave blank to skip",
      required: false,
      secret: true,
    },
  ],
} satisfies StackMeta
