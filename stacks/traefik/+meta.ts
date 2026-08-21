// Stack metadata for `traefik`.
//
// First 6 stacks tracked by the v1 catalog (docs/v1-cli.md §11, Phase 4).
// Traefik is the reverse proxy that fronts the catalog — every other
// stack's `<SERVICE>_DOMAIN` is a Traefik label.
//
// Variable shape: a single PROXY_DOMAIN with default `traefik.${DOMAIN}`.
// Phase 5 wizard renders the default as editable text via cliffy's
// Input.prompt({ default }) so users can swap the subdomain if they
// front Traefik on a non-canonical name.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "traefik",
  description: "Reverse proxy with auto-TLS via Let's Encrypt",
  category: "proxy",
  variables: [
    {
      key: "IMAGE_TAG",
      // Compose currently hardcodes "traefik:3.7.6". Declared per design
      // convention (docs/v1-cli.md §4) so future compose updates can wire
      // `${IMAGE_TAG}` without re-touching this file.
      default: "3.7.6",
      required: false,
    },
    {
      key: "PROXY_DOMAIN",
      question: "Public domain for the Traefik dashboard?",
      // v1 design: ${DOMAIN} resolves to the server's apex domain
      // (set during server-create). Wizard pre-fills this as editable.
      default: "traefik.${DOMAIN}",
      required: true,
    },
    {
      key: "CONTACT_EMAIL",
      question: "Email for Let's Encrypt ACME registration?",
      required: true,
    },
    {
      key: "PROXY_CPU_LIMIT",
      question: "CPU limit for the Traefik container?",
      default: "1",
      required: true,
    },
    {
      key: "PROXY_MEM_LIMIT",
      question: "Memory limit for the Traefik container?",
      default: "512M",
      required: true,
    },
  ],
} satisfies StackMeta
