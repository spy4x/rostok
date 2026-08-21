// Stack metadata for `librespeed`.
//
// First 6 stacks tracked by the v1 catalog (docs/v1-cli.md §11, Phase 4).
// LibreSpeed is a self-hosted speed-test tool. Stateless — no `backup.ts`.
// Uses `generatePassword()` for the dashboard password per docs/v1-cli.md §4.
//
// Variable shape: single LIBRESPEED_DOMAIN, default `speedtest.${DOMAIN}`.
//
// Server-level vars (TIMEZONE, PUID, PGID) intentionally NOT declared
// here — same convention as filebrowser. See `stacks/filebrowser/+meta.ts`.

import type { StackMeta } from "@rostok/cli"
import { generatePassword } from "@rostok/cli"

export default {
  name: "librespeed",
  description: "Self-hosted speed-test tool (librespeed/speedtest)",
  category: "tools",
  variables: [
    {
      key: "IMAGE_TAG",
      default: "latest",
      required: false,
    },
    {
      key: "LIBRESPEED_DOMAIN",
      question: "Public domain for the speed-test page?",
      default: "speedtest.${DOMAIN}",
      required: true,
    },
    {
      key: "LIBRESPEED_CPU_LIMIT",
      question: "CPU limit for the LibreSpeed container?",
      default: "0.5",
      required: true,
    },
    {
      key: "LIBRESPEED_MEM_LIMIT",
      question: "Memory limit for the LibreSpeed container?",
      default: "256M",
      required: true,
    },
    {
      key: "LIBRESPEED_PASSWORD",
      question: "Dashboard password (auto-generated at deploy time)?",
      // Lazy default — called once at resolution time. Per the design §4
      // prompt rule, required + default → skip prompt and use the value.
      default: () => generatePassword(16),
      required: true,
      secret: true,
    },
  ],
} satisfies StackMeta
