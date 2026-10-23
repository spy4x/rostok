// Stack metadata for `stalwart`.
//
// Stalwart is a self-hosted mail server with JMAP, CalDAV and CardDAV. The web UI and JMAP sit
// at `mail.${DOMAIN}` behind Traefik; SMTP and IMAP ports are published on the host. A
// `cert-sync` sidecar copies Let's Encrypt certificates from Traefik's `acme.json` into
// Stalwart, so the stack requires Traefik. `acme.json` is a file mount (#258): deploy never
// creates it, it only checks that Traefik has already written it.
//
// Variable shape:
//   - STALWART_DOMAIN, STALWART_MTA_STS_DOMAIN: the Traefik hosts, defaulting to `mail.${DOMAIN}`
//     and `mta-sts.${DOMAIN}`. The deploy hooks, the DKIM checks and the cert-sync sidecar always
//     talk to `mail.${DOMAIN}`, so change STALWART_DOMAIN only together with that.
//   - STALWART_WEBMAIL_ORIGIN: the one browser origin allowed to call JMAP from another host,
//     defaulting to the bulwark stack's `https://webmail.${DOMAIN}`.
//   - STALWART_ADMIN_PASSWORD: password of the `admin` recovery account, used by the deploy
//     hooks and the cert-sync sidecar. Generated.
//   - STALWART_EXTRA_DOMAINS: further mail domains on the same MX, comma-separated. Optional:
//     blank means DOMAIN is the only mail domain. For each one the deploy hooks check DKIM,
//     Traefik routes `mta-sts.<domain>` and cert-sync copies the `mail.<domain>` certificate.
//     before.deploy.ts writes both into the deployed copy of compose.yml on every deploy.
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
      key: "STALWART_IMAGE_TAG",
      default: "v0.16.27",
      required: false,
    },
    {
      key: "STALWART_MTA_STS_IMAGE_TAG",
      default: "alpine",
      required: false,
    },
    {
      key: "STALWART_CERT_SYNC_IMAGE_TAG",
      default: "3-alpine",
      required: false,
    },
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
      key: "STALWART_WEBMAIL_ORIGIN",
      question: "Origin (https://host) of the webmail allowed to call JMAP from the browser?",
      default: "https://webmail.${DOMAIN}",
      required: true,
    },
    {
      key: "STALWART_ADMIN_PASSWORD",
      question: "Password for the Stalwart admin account?",
      default: () => generatePassword(32),
      required: true,
      secret: true,
    },
    {
      key: "STALWART_EXTRA_DOMAINS",
      question: "Further mail domains served on the same MX, comma-separated? Leave blank for none",
      required: false,
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
