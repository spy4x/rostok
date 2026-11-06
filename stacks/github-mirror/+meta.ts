// Stack metadata for `github-mirror`.
//
// A small Deno script (mirror.ts) that adds a Gitea pull mirror for each GitHub repository the
// token's account owns, so new repositories are mirrored without a manual step. Internal only: no
// Traefik route and no domain. It reaches Gitea as `http://hl-gitea:3000` on the `proxy` network.
//
// Both tokens come from outside, so they have no default: `stack add` asks for them. Stateless:
// the mirrors live in Gitea, whose backup covers them, so this stack has no backup.ts.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "github-mirror",
  description: "Mirrors every GitHub repository of one account into Gitea",
  category: "devtools",
  requires: ["gitea"],
  variables: [
    {
      key: "GITHUB_MIRROR_IMAGE_TAG",
      default: "alpine-2.9.7",
      required: false,
    },
    {
      key: "GITHUB_MIRROR_GITHUB_TOKEN",
      question: "GitHub token that reads all your repositories (Contents and Metadata: read)?",
      required: true,
      secret: true,
    },
    {
      key: "GITHUB_MIRROR_GITEA_TOKEN",
      question: "Gitea token of the user that owns the mirrors (write:repository, read:user)?",
      required: true,
      secret: true,
    },
  ],
} satisfies StackMeta
