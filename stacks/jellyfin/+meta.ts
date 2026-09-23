// Stack metadata for `jellyfin`.
//
// First 6 stacks tracked by the v1 catalog (docs/v1-cli.md §11, Phase 4).
// Jellyfin is a self-hosted media server.
//
// Variable shape: JELLYFIN_DOMAIN (default `movies.${DOMAIN}`) plus the
// PATH_* media mounts compose reads. PATH_MEDIA/PATH_VIDEOS/PATH_MUSIC
// are server-level keys (isServerKey() matches any PATH_* key), not
// stack-prefixed — filebrowser declares the same three keys and both
// stacks share one value per key in the server's .env.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "jellyfin",
  description: "Self-hosted media server (movies, TV, music, books)",
  category: "media",
  variables: [
    {
      key: "JELLYFIN_IMAGE_TAG",
      default: "latest",
      required: false,
    },
    {
      key: "JELLYFIN_DOMAIN",
      question: "Public domain for Jellyfin?",
      default: "movies.${DOMAIN}",
      required: true,
    },
    {
      key: "PATH_MEDIA",
      question: "Host path for the media library?",
      default: "${VOLUMES_PATH}/media",
      required: true,
    },
    {
      key: "PATH_VIDEOS",
      question: "Host path for the videos library?",
      default: "${VOLUMES_PATH}/videos",
      required: true,
    },
    {
      key: "PATH_MUSIC",
      question: "Host path for the music library?",
      default: "${VOLUMES_PATH}/music",
      required: true,
    },
  ],
} satisfies StackMeta
