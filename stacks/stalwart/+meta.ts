// Stack metadata for `stalwart`.
//
// Stalwart is a self-hosted mail server with JMAP, CalDAV and CardDAV. The web UI and JMAP sit
// at `mail.${DOMAIN}` behind Traefik; SMTP and IMAP ports are published on the host. A
// `cert-sync` sidecar copies Let's Encrypt certificates from Traefik's `acme.json` into
// Stalwart, so the stack requires Traefik. `acme.json` is a file mount (#258): deploy never
// creates it, it only checks that Traefik has already written it.
//
// Variable shape:
//   - STALWART_DOMAIN, STALWART_MTA_STS_DOMAIN, STALWART_MTA_STS_SECONDARY_DOMAIN: the Traefik
//     hosts, defaulting to `mail.${DOMAIN}` and `mta-sts.${DOMAIN}`; the secondary one has no default and
//     compose derives it from STALWART_NEATSOFT_DOMAIN. The deploy hooks, the DKIM
//     checks and the cert-sync sidecar always talk to `mail.${DOMAIN}`, so change
//     STALWART_DOMAIN only together with that.
//   - STALWART_ADMIN_PASSWORD: password of the `admin` recovery account, used by the deploy
//     hooks and the cert-sync sidecar. Generated.
//   - STALWART_NEATSOFT_DOMAIN: a second mail domain on the same MX, whose DKIM setup the
//     deploy hooks check. Route its MTA-STS host with STALWART_MTA_STS_SECONDARY_DOMAIN. The
//     key keeps its original name so existing servers need no change. The default is `${DOMAIN}`
//     itself, which makes a server with one mail domain work.
//   - STALWART_INITIAL_DEPLOY: set to `true` only for the very first deploy, when no live
//     Stalwart exists yet for the hooks to talk to. Not required.
//
// Server-level vars (PROJECT, DOMAIN, TIMEZONE, VOLUMES_PATH, PATH_APPS) intentionally NOT
// declared here.

import type { StackMeta } from "@rostok/cli"
import { generatePassword } from "@rostok/cli"

export default {
  name: "stalwart",
  description:
    "Self-hosted mail server (Stalwart) with Let's Encrypt certificates synced from Traefik",
  category: "productivity",
  requires: ["traefik"],
  // the mail server runs as its own user and owns its data folders: deploy must not chown the folder to PUID:PGID.
  keepOwner: ["stalwart/data", "stalwart/config", "stalwart/lib"],
  variables: [
    {
      key: "STALWART_DOMAIN",
      question: "Public domain for the Stalwart web UI and JMAP?",
      default: "mail.${DOMAIN}",
      required: true,
    },
    {
      key: "STALWART_MTA_STS_DOMAIN",
      question: "Host serving the MTA-STS policy of the primary domain?",
      default: "mta-sts.${DOMAIN}",
      required: true,
    },
    {
      key: "STALWART_MTA_STS_SECONDARY_DOMAIN",
      // No default: compose falls back to `mta-sts.${STALWART_NEATSOFT_DOMAIN}`, a reference a
      // meta default cannot express. Leave blank unless that host is wrong.
      question:
        "Host serving the MTA-STS policy of the second mail domain? Leave blank for the default",
      required: false,
    },
    {
      key: "STALWART_ADMIN_PASSWORD",
      question: "Password for the Stalwart admin account?",
      default: () => generatePassword(32),
      required: true,
      secret: true,
    },
    {
      key: "STALWART_NEATSOFT_DOMAIN",
      question:
        "Second mail domain served on the same MX? Use the primary domain if there is only one",
      default: "${DOMAIN}",
      required: true,
    },
    {
      key: "STALWART_INITIAL_DEPLOY",
      question: "Is this the first deploy, with no running Stalwart yet?",
      default: "false",
      required: false,
    },
    {
      key: "STALWART_MEM_LIMIT",
      question: "Memory limit for the Stalwart container?",
      default: "512M",
      required: true,
    },
    {
      key: "STALWART_CPU_LIMIT",
      question: "CPU limit for the Stalwart container?",
      default: "0.5",
      required: true,
    },
  ],
  fileMounts: ["traefik/letsencrypt/acme.json"],
} satisfies StackMeta
