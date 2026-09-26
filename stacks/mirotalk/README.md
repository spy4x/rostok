# MiroTalk

Peer-to-peer video calls — no account needed, no server-side media processing.

Bundled `coturn` provides the TURN relay. Without TURN, peers behind NAT cannot
establish media connections and calls will hang with both participants
"connected" but no audio/video flowing.

## Features

- WebRTC P2P video/audio calls
- Screen sharing
- Chat during calls
- Room-based with shareable links
- No registration required

## Access

Web UI: `https://talk.${DOMAIN}`

## Required env vars

- `MIROTALK_TURN_SERVER_USERNAME` — long random string (coturn credential user)
- `MIROTALK_TURN_SERVER_CREDENTIAL` — long random string (coturn credential password)
- `MIROTALK_PUBLIC_IP` — host's external IPv4. coturn hardcodes this in `external-ip=`;
  required because cloud VPS interfaces don't carry the public IP directly.

## Host firewall

coturn uses `network_mode: host` so it binds directly on the host interface.
Public-inbound ports required:

- `3478/udp` — STUN + TURN control + UDP relay
- `5349/tcp` — TURN over TLS (fallback for networks blocking UDP)
- `10000-20000/udp` — relay port range

On Hetzner Cloud, add these to the server's firewall in the Cloud Console (or
via the API). On hosts running `firewalld`/`nftables`, allow the same.

## TURN over TLS

The browser advertises `turns://${DOMAIN}:5349` to peers. The
`mirotalk-cert-extract` sidecar watches Traefik's `acme.json` and writes
PEM files to a shared volume that coturn mounts — so Let's Encrypt
renewals propagate automatically.

Why this matters: peer-to-peer WebRTC tries direct UDP first, falls back
to TURN-over-UDP when symmetric NAT blocks it. When the peer's network
blocks UDP entirely (corporate firewalls, some hotel/captive WiFi), the
browser needs `turns://` on TCP 5349. Without it the call hangs
indefinitely with both peers "connected" but no media.

## Usage

Create a room, share the link. Participants join in browser — no install.

## Resources

- [MiroTalk P2P GitHub](https://github.com/miroslavpejic85/mirotalk)
- [coturn](https://github.com/coturn/coturn)

## Deploy order

The `mirotalk-cert-extract` sidecar mounts Traefik's
`${VOLUMES_PATH}/traefik/letsencrypt/acme.json`. `+meta.ts` declares it
in `fileMounts`, so deploy checks that the file exists before it changes
any stack, stops if it doesn't, and never creates a folder in its place.
On a new server, deploy Traefik first and let it start once, so it
writes `acme.json`. If this stack is already in `config.json`, run
`rostok deploy <server> traefik` for that first deploy, then deploy the
whole server.
