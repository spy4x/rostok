// Stack metadata for `home-assistant`.
//
// Home Assistant runs with HOST networking (`compose.yml`), because
// mDNS/SSDP/DHCP discovery of LAN devices does not cross a Docker bridge.
// No Traefik label, so no `requires: ["traefik"]` and no domain variable;
// it is reachable on http://<lan-ip>:8123. Only for a trusted network.
//
// The CLI deploys `compose.yml` plus an optional per-server
// `compose-override/home-assistant.yml`; it has no "variant" switch. The
// Traefik-routed variant is therefore a manual override (see README).
//
// Server-level vars (TIMEZONE, VOLUMES_PATH) intentionally NOT declared
// here — same convention as filebrowser.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "home-assistant",
  description: "Open source home automation, host networking for LAN device discovery",
  category: "home",
  variables: [
    {
      key: "HOME_ASSISTANT_ZIGBEE_DEVICE",
      question: "Host path of the Zigbee USB dongle to pass through?",
      default: "/dev/ttyUSB0",
      required: true,
    },
    {
      key: "HOME_ASSISTANT_CPU_LIMIT",
      question: "CPU limit for the Home Assistant container?",
      default: "2",
      required: true,
    },
    {
      key: "HOME_ASSISTANT_MEM_LIMIT",
      question: "Memory limit for the Home Assistant container?",
      default: "2048M",
      required: true,
    },
  ],
} satisfies StackMeta
