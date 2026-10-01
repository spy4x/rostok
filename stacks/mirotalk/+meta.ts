// Stack metadata for `mirotalk`.
//
// MiroTalk P2P video calls plus a coturn TURN relay, so calls work behind NAT.
//
// - MIROTALK_DOMAIN: the call site. coturn serves TURN over TLS (5349) for the same host, using
//   the Let's Encrypt certificate the `mirotalk-cert-extract` sidecar copies out of Traefik's
//   `acme.json`, so the certificate and the TURN URL name the same host.
// - MIROTALK_TURN_SERVER_USERNAME / _CREDENTIAL: coturn's long-term credential, generated.
// - MIROTALK_PUBLIC_IP: the server's external IPv4. It comes from outside (a cloud VPS interface
//   does not carry it), so it has no default: `stack add` asks for it.
// - fileMounts: the sidecar mounts `acme.json` read-only. It is a file, so deploy must never
//   mkdir or chown it, only check that Traefik already wrote it (#258).

import type { StackMeta } from "@rostok/cli"
import { generatePassword } from "@rostok/cli"

export default {
  name: "mirotalk",
  description: "Peer-to-peer video calls with a bundled TURN relay (MiroTalk P2P + coturn)",
  category: "communication",
  requires: ["traefik"],
  variables: [
    {
      key: "MIROTALK_IMAGE_TAG",
      default: "latest",
      required: false,
    },
    {
      key: "MIROTALK_DOMAIN",
      question: "Public domain for MiroTalk?",
      default: "talk.${DOMAIN}",
      required: true,
    },
    {
      key: "MIROTALK_PUBLIC_IP",
      question: "Server's public IPv4 address (coturn advertises it to peers)?",
      required: true,
    },
    {
      key: "MIROTALK_TURN_SERVER_USERNAME",
      default: () => generatePassword(24),
      required: true,
      secret: true,
    },
    {
      key: "MIROTALK_TURN_SERVER_CREDENTIAL",
      default: () => generatePassword(48),
      required: true,
      secret: true,
    },
  ],
  fileMounts: ["traefik/letsencrypt/acme.json"],
} satisfies StackMeta
