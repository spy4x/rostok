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

- `TURN_SERVER_USERNAME` — long random string (coturn credential user)
- `TURN_SERVER_CREDENTIAL` — long random string (coturn credential password)
- `PUBLIC_IP` — host's external IPv4. coturn hardcodes this in `external-ip=`;
  required because cloud VPS interfaces don't carry the public IP directly.

## Host firewall

coturn uses `network_mode: host` so it binds directly on the host interface.
Public-inbound ports required:

- `3478/udp`, `3478/tcp` — TURN control + relay
- `10000-20000/udp` — relay port range (per upstream `turnserver.template.conf`)

On Hetzner Cloud, add these to the server's firewall in the Cloud Console (or
via the API). On hosts running `firewalld`/`nftables`, allow the same.

## TURN TLS (not enabled)

Currently plain UDP/TCP only — no `turns://` on 5349. Media itself stays
DTLS-SRTP encrypted regardless; only the TURN _control_ channel is plaintext,
which is acceptable for personal 1-on-1 use.

To enable TURN-TLS later: add a `traefik-certs-dumper` sidecar that extracts
the Let's Encrypt cert from Traefik's `acme.json` to on-disk PEM files, then
bind-mount those into the coturn container and add `--tls-listening-port=5349`,
`--cert`, `--pkey` to the `command:` list.

## Usage

Create a room, share the link. Participants join in browser — no install.

## Resources

- [MiroTalk P2P GitHub](https://github.com/miroslavpejic85/mirotalk)
- [coturn](https://github.com/coturn/coturn)
