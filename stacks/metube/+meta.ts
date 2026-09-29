// Stack metadata for `metube`.
//
// Routes through Traefik at `metube.${DOMAIN}` behind the `authelia@file` middleware. Downloads go to PATH_VIDEOS and PATH_MUSIC.
// PATH_VIDEOS and PATH_MUSIC are shared server-level keys that compose mounts; declared here like
// jellyfin does so a fresh server gets a value.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "metube",
  description: "Web front end for yt-dlp downloads (alexta69/metube)",
  category: "media",
  requires: ["traefik"],
  variables: [
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
