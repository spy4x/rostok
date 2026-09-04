// Stack metadata for `deepseek-harness`.
//
// Host-level install (NOT a Docker stack — see README §"Why host-level").
// The wizard's `stack add` still picks this up; the variable drives the
// `npm install --prefix ~/.local -g @deepseek-ai/dsh@<DSH_VERSION>` line.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "deepseek-harness",
  description: "AI agent harness with plugin-based web UI (DeepSeek) — host-level",
  category: "productivity",
  variables: [
    {
      // npm dist-tag for the `npm install` line. `latest` is currently
      // tracking `0.1.x-rc`; pin deliberately for reproducible installs.
      key: "DSH_VERSION",
      default: "0.1.1-rc.2",
      required: false,
    },
  ],
} satisfies StackMeta
