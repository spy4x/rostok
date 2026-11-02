// Stack metadata for `xray`.
//
// Xray-core VPN with VLESS + Reality, for clients behind a censor that blocks plain VPNs. Traefik
// passes TLS connections that name the decoy site to it on :443, so it requires traefik.
//
// Variable shape:
//   - XRAY_REALITY_SNI: the decoy site. A real foreign site with TLS 1.3 and HTTP/2 that the
//     censor does not block; a probe that is not a client gets that site's real answer.
//   - XRAY_REALITY_PRIVATE_KEY: X25519 private key, base64url without padding. Any 32 random
//     bytes are a valid X25519 key (the curve clamps them), so it is generated without a library.
//   - XRAY_REALITY_SHORT_ID: hex, 16 characters. Every client link carries it.
//   - XRAY_CLIENTS: JSON array of VLESS clients. The generated one has a version 7 UUID id.
//
// Server-level vars intentionally NOT declared here.

import type { StackMeta } from "@rostok/cli"
import { encodeBase64Url, encodeHex } from "@std/encoding"
import { uuidV7 } from "@spy4x/platform/universal/uuid"

const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n))

export default {
  name: "xray",
  description: "Censorship-resistant VPN (Xray-core, VLESS + Reality)",
  category: "infra",
  requires: ["traefik"],
  variables: [
    {
      key: "XRAY_IMAGE_TAG",
      default: "26.10.31",
      required: false,
    },
    {
      key: "XRAY_REALITY_SNI",
      question: "Decoy site clients pretend to visit (a real foreign TLS 1.3 site)?",
      default: "www.samsung.com",
      required: true,
    },
    {
      key: "XRAY_REALITY_PRIVATE_KEY",
      question: "Reality X25519 private key (auto-generated)?",
      default: () => encodeBase64Url(randomBytes(32)),
      required: true,
      secret: true,
    },
    {
      key: "XRAY_REALITY_SHORT_ID",
      question: "Reality short id, hex (auto-generated)?",
      default: () => encodeHex(randomBytes(8)),
      required: true,
      secret: true,
    },
    {
      key: "XRAY_CLIENTS",
      question: "VLESS clients as a JSON array (one is generated)?",
      default: () =>
        JSON.stringify([{ id: uuidV7(), email: "client-1", flow: "xtls-rprx-vision" }]),
      required: true,
      secret: true,
    },
  ],
} satisfies StackMeta
