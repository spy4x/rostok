// Stack metadata for `ci-agent`.
//
// A Woodpecker agent alone, for a second machine. It connects to the gRPC host the `woodpecker`
// stack publishes when its WOODPECKER_GRPC_DOMAIN is set. Keys carry this stack's own prefix,
// because the catalog keeps every key to one stack; the secret is asked, since it must be a copy
// of the server's.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "ci-agent",
  description: "Woodpecker CI agent for a second machine, connecting to a woodpecker server",
  category: "devtools",
  variables: [
    {
      key: "CI_AGENT_IMAGE_TAG",
      default: "v3.19.0",
      required: false,
    },
    {
      key: "CI_AGENT_GRPC_DOMAIN",
      question: "gRPC host of the Woodpecker server (its WOODPECKER_GRPC_DOMAIN)?",
      required: true,
    },
    {
      key: "CI_AGENT_SECRET",
      question: "Agent secret of the Woodpecker server (its WOODPECKER_AGENT_SECRET)?",
      required: true,
      secret: true,
    },
    {
      key: "CI_AGENT_MAX_WORKFLOWS",
      default: "4",
      required: false,
    },
  ],
} satisfies StackMeta
