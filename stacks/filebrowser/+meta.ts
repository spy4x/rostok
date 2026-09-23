// Stack metadata for `filebrowser`.
//
// First 6 stacks tracked by the v1 catalog (docs/v1-cli.md §11, Phase 4).
// Filebrowser is a self-hosted file manager.
//
// Variable shape: FILEBROWSER_DOMAIN (default `files.${DOMAIN}`) plus
// the PATH_* mounts compose reads. These are server-level keys
// (isServerKey() matches any PATH_* key), not stack-prefixed — jellyfin
// declares PATH_MEDIA/PATH_VIDEOS/PATH_MUSIC too, and both stacks share
// one value per key in the server's .env.
//
// Server-level vars (TIMEZONE, PUID, PGID) intentionally NOT declared
// here — they live in `servers/<server>/.env`, written by `server
// create`, and compose reads them directly.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "filebrowser",
  description: "Self-hosted web-based file manager",
  category: "storage",
  variables: [
    {
      key: "FILEBROWSER_IMAGE_TAG",
      default: "latest",
      required: false,
    },
    {
      key: "FILEBROWSER_DOMAIN",
      question: "Public domain for Filebrowser?",
      default: "files.${DOMAIN}",
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
    {
      key: "PATH_BOOKS",
      question: "Host path for the books library?",
      default: "${VOLUMES_PATH}/books",
      required: true,
    },
    {
      key: "PATH_SYNC",
      question: "Host path for synced files?",
      default: "${VOLUMES_PATH}/sync",
      required: true,
    },
    {
      key: "PATH_MOVIES",
      question: "Host path for movies?",
      default: "${VOLUMES_PATH}/movies",
      required: true,
    },
    {
      key: "PATH_SERIES",
      question: "Host path for TV series?",
      default: "${VOLUMES_PATH}/series",
      required: true,
    },
    {
      key: "PATH_OTHER",
      question: "Host path for everything else?",
      default: "${VOLUMES_PATH}/other",
      required: true,
    },
  ],
} satisfies StackMeta
