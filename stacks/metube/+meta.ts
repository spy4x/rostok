// Stack metadata for `metube`.
//
// Routes through Traefik at `metube.${DOMAIN}` behind the `authelia@file` middleware. Downloads go to PATH_VIDEOS and PATH_MUSIC.
// Server-level keys are not declared here (see cli/server-keys.ts).

import type { StackMeta } from "@rostok/cli"

export default {
  name: "metube",
  description: "Web front end for yt-dlp downloads (alexta69/metube)",
  category: "media",
  requires: ["traefik"],
  variables: [],
} satisfies StackMeta
