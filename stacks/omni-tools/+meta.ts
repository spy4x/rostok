// Stack metadata for `omni-tools`.
//
// A static web app of everyday tools; all processing happens in the browser, so the stack is
// stateless (no `backup.ts`). Web UI sits behind Traefik, so the stack requires it.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "omni-tools",
  description: "Everyday online tools that run in your browser (iib0011/omni-tools)",
  category: "tools",
  requires: ["traefik"],
  variables: [
    {
      key: "OMNI_TOOLS_DOMAIN",
      question: "Public domain for OmniTools?",
      default: "tools.${DOMAIN}",
      required: true,
    },
    {
      key: "OMNI_TOOLS_CPU_LIMIT",
      question: "CPU limit for the OmniTools container?",
      default: "0.5",
      required: true,
    },
    {
      key: "OMNI_TOOLS_MEM_LIMIT",
      question: "Memory limit for the OmniTools container?",
      default: "256M",
      required: true,
    },
  ],
} satisfies StackMeta
