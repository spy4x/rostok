// Stack metadata for `pangolin`.
//
// Pangolin is a self-hosted tunnel broker: remote sites dial in over WireGuard (gerbil) and
// Pangolin publishes their services under its own host names, with HTTPS from a second Traefik
// (`hl-pangolin-traefik`) that shares gerbil's network namespace. The main Traefik keeps the
// host's ports 80/443 and passes Pangolin's host names through to gerbil by SNI, a server file
// in `configs/traefik/dynamic/` (see the README). That and the external `proxy` network are why
// the stack requires traefik.
//
// Variable shape:
//   - PANGOLIN_DOMAIN: the dashboard host, default `tunnel.${DOMAIN}`. before.deploy.ts writes it
//     into the routers of `traefik/dynamic/00-pangolin.yml`; it must match `dashboard_url` in
//     Pangolin's own `config.yml`, which lives in the `pangolin-config` volume.
//   - PANGOLIN_*_CONTAINER_NAME: container names, defaulting to hl-pangolin, hl-gerbil and
//     hl-pangolin-traefik.
//   - PANGOLIN_*_MEM_LIMIT / PANGOLIN_*_CPU_LIMIT: limits for each of the three containers.
//
// Server-level vars (PROJECT, DOMAIN, CONTACT_EMAIL) intentionally NOT declared here;
// before.deploy.ts writes CONTACT_EMAIL into the ACME settings of `traefik/traefik_config.yml`.
// Data lives in the named volumes `pangolin-config` and `pangolin-letsencrypt`, so the stack must
// keep deploying as project `pangolin` for them to stay attached.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "pangolin",
  description: "Self-hosted tunnel broker: publish services of remote sites over WireGuard",
  category: "proxy",
  requires: ["traefik"],
  variables: [
    {
      key: "PANGOLIN_DOMAIN",
      question: "Public domain for the Pangolin dashboard?",
      default: "tunnel.${DOMAIN}",
      required: true,
    },
    {
      key: "PANGOLIN_CONTAINER_NAME",
      default: "hl-pangolin",
      required: false,
    },
    {
      key: "PANGOLIN_GERBIL_CONTAINER_NAME",
      default: "hl-gerbil",
      required: false,
    },
    {
      key: "PANGOLIN_TRAEFIK_CONTAINER_NAME",
      default: "hl-pangolin-traefik",
      required: false,
    },
    {
      key: "PANGOLIN_MEM_LIMIT",
      question: "Memory limit for the Pangolin container?",
      default: "1024M",
      required: true,
    },
    {
      key: "PANGOLIN_CPU_LIMIT",
      question: "CPU limit for the Pangolin container?",
      default: "1",
      required: true,
    },
    {
      key: "PANGOLIN_GERBIL_MEM_LIMIT",
      question: "Memory limit for the gerbil (WireGuard) container?",
      default: "128M",
      required: true,
    },
    {
      key: "PANGOLIN_GERBIL_CPU_LIMIT",
      question: "CPU limit for the gerbil (WireGuard) container?",
      default: "0.5",
      required: true,
    },
    {
      key: "PANGOLIN_TRAEFIK_MEM_LIMIT",
      question: "Memory limit for Pangolin's Traefik container?",
      default: "512M",
      required: true,
    },
    {
      key: "PANGOLIN_TRAEFIK_CPU_LIMIT",
      question: "CPU limit for Pangolin's Traefik container?",
      default: "0.5",
      required: true,
    },
  ],
} satisfies StackMeta
