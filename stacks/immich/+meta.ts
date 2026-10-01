// Stack metadata for `immich`.
//
// Photo library with machine learning and a kiosk slideshow. Web UI at `photos.${DOMAIN}`,
// kiosk at `kiosk.${DOMAIN}`, both behind Traefik. The compose file uses NVIDIA hardware:
// NVENC transcoding and the CUDA machine-learning image, so the host needs an NVIDIA GPU with
// the container toolkit (see the README).
//
// Variable shape:
//   - IMMICH_VERSION: image tag, `release` like compose.
//   - IMMICH_DB_PASSWORD, IMMICH_KIOSK_PASSWORD: secrets, generated at `stack add`.
//   - IMMICH_MCP_API_KEY, IMMICH_KIOSK_API_KEY: Immich API keys. They can only be created in
//     the Immich UI after the first deploy, so they are optional here: leave them empty, deploy,
//     create the keys, put them in `.env` and deploy again.
//   - IMMICH_KIOSK_EXCLUDED_PEOPLE: comma-separated Immich person IDs the kiosk never shows.
//
//   - PATH_PHOTOS: host folder of the photo library. Shared by name with other stacks, so it
//     stays one value per key in the server's .env. `server create` does not write it (only
//     the keys in SERVER_KEYS, cli/server-keys.ts), so this stack declares it.
//
// Server-level vars (TIMEZONE, VOLUMES_PATH) intentionally NOT declared here.

import type { StackMeta } from "@rostok/cli"
import { generatePassword } from "@rostok/cli"

export default {
  name: "immich",
  description: "Photo library with machine learning and kiosk slideshow (immich-app/immich)",
  category: "media",
  requires: ["traefik"],
  // Postgres runs as its own user: deploy must not chown its folder to PUID:PGID (#312).
  keepOwner: ["immich/postgres"],
  variables: [
    {
      key: "IMMICH_DOMAIN",
      question: "Public domain for Immich?",
      default: "photos.${DOMAIN}",
      required: true,
    },
    {
      key: "IMMICH_KIOSK_DOMAIN",
      question: "Public domain for the Immich kiosk slideshow?",
      default: "kiosk.${DOMAIN}",
      required: true,
    },
    {
      key: "IMMICH_VERSION",
      question: "Immich image tag?",
      default: "release",
      required: false,
    },
    {
      key: "IMMICH_DB_PASSWORD",
      question: "Postgres password (auto-generated)?",
      default: () => generatePassword(32),
      required: true,
      secret: true,
    },
    {
      key: "IMMICH_KIOSK_PASSWORD",
      question: "Kiosk page password (auto-generated)?",
      default: () => generatePassword(16),
      required: true,
      secret: true,
    },
    {
      key: "IMMICH_MCP_API_KEY",
      question:
        "Immich API key for thumbnail requests (create it in Immich after the first deploy)?",
      required: false,
      secret: true,
    },
    {
      key: "IMMICH_KIOSK_API_KEY",
      question: "Immich API key for the kiosk (create it in Immich after the first deploy)?",
      required: false,
      secret: true,
    },
    {
      key: "IMMICH_KIOSK_EXCLUDED_PEOPLE",
      question: "Immich person IDs the kiosk must never show (comma-separated, may be empty)?",
      required: false,
    },
    {
      key: "PATH_PHOTOS",
      question: "Host path for the photo library?",
      default: "${VOLUMES_PATH}/photos",
      required: true,
    },
  ],
} satisfies StackMeta
