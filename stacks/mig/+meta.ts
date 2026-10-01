// Stack metadata for `mig`.
//
// mig is a tiny self-hosted meeting scheduler (github.com/spy4x/mig), served at
// `meet.${DOMAIN}` behind Traefik. Its own settings (host name, availability, SMTP, cancel
// secret, ...) live in the operator-written file `${PATH_APPS}/configs/mig.env`, which
// `servers/<server>/configs/mig.env` provides: see the stack README. The stack cannot start
// without that file, so write it before the first deploy.
//
// Variable shape:
//   - MIG_DOMAIN: single var, default `meet.${DOMAIN}`. Set `PUBLIC_URL` in `mig.env` to match.
//   - MIG_IMAGE_TAG: image tag, `latest` follows mig's stable releases.
//   - MIG_MIDDLEWARES: Traefik middleware chain for every path outside `/embed`.
//   - MIG_EMBED_MIDDLEWARES: chain for `/embed` only. No default on purpose: compose falls back
//     to MIG_MIDDLEWARES, so leaving it unset keeps embedding off (see the README).
//
// Server-level vars (PROJECT, DOMAIN, VOLUMES_PATH, PATH_APPS, PUID, PGID) intentionally NOT
// declared here.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "mig",
  description: "Tiny self-hosted meeting scheduler: one owner, one URL, book a time slot",
  category: "productivity",
  requires: ["traefik"],
  variables: [
    {
      key: "MIG_DOMAIN",
      question: "Public domain for the scheduler?",
      default: "meet.${DOMAIN}",
      required: true,
    },
    {
      key: "MIG_IMAGE_TAG",
      default: "latest",
      required: false,
    },
    {
      key: "MIG_MIDDLEWARES",
      default: "security-headers@file,compression@file,robots-deny@file",
      required: false,
    },
    {
      key: "MIG_EMBED_MIDDLEWARES",
      question: "Traefik middleware chain for /embed (to allow framing)? Leave blank to skip",
      required: false,
    },
  ],
} satisfies StackMeta
