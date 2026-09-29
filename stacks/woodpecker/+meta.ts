// Stack metadata for `woodpecker`.
//
// CI server plus a Docker agent at `ci.${DOMAIN}`, signing in through a GitHub OAuth app.
// The agent secret is generated; the OAuth client ID and secret and the admin login come from
// the owner's GitHub account, so they have no default.

import type { StackMeta } from "@rostok/cli"
import { generatePassword } from "@rostok/cli"

export default {
  name: "woodpecker",
  description: "CI server and Docker agent (woodpeckerci) with GitHub sign-in",
  category: "devtools",
  requires: ["traefik"],
  variables: [
    {
      key: "WOODPECKER_DOMAIN",
      question: "Public domain for Woodpecker?",
      default: "ci.${DOMAIN}",
      required: true,
    },
    {
      key: "WOODPECKER_AGENT_SECRET",
      question: "Shared secret between server and agent (auto-generated)?",
      default: () => generatePassword(32),
      required: true,
      secret: true,
    },
    {
      key: "WOODPECKER_GITHUB_CLIENT",
      question: "GitHub OAuth app client ID?",
      required: true,
    },
    {
      key: "WOODPECKER_GITHUB_SECRET",
      question: "GitHub OAuth app client secret?",
      required: true,
      secret: true,
    },
    {
      key: "WOODPECKER_ADMIN",
      question: "GitHub login of the Woodpecker admin?",
      required: true,
    },
  ],
} satisfies StackMeta
