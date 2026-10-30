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

Web UI: `https://<MIROTALK_DOMAIN>`

## Configuration

`rostok stack add mirotalk` writes these.

- `MIROTALK_IMAGE_TAG` — image tag, default `latest`
- `MIROTALK_COTURN_IMAGE_TAG` — image tag of `coturn/coturn`, default `latest`
- `MIROTALK_CERT_EXTRACT_IMAGE_TAG` — image tag of `python` in `mirotalk-cert-extract`, default `3-alpine`
- `MIROTALK_DOMAIN` — public host, default `talk.${DOMAIN}`. The TURN URL and the TLS
  certificate coturn serves use the same host.
- `MIROTALK_TURN_SERVER_USERNAME` — long random string (coturn credential user), generated.
  Required: the deploy stops when it is missing.
- `MIROTALK_TURN_SERVER_CREDENTIAL` — long random string (coturn credential password), generated.
  Required in the same way.
- `MIROTALK_JWT_KEY` — key MiroTalk signs its room and API tokens with, generated. Required: the
  image exits at start without one of at least 32 characters, so the deploy stops when it is
  missing.
- `MIROTALK_API_KEY_SECRET` — key MiroTalk's REST API (`/api/v1/...`) asks for in the
  `authorization` header, generated. Required: without it the image uses a default key that
  MiroTalk's documentation prints, so the deploy stops when it is missing.
- `MIROTALK_PUBLIC_IP` — host's external IPv4, asked for. coturn hardcodes this in `external-ip=`;
  required because cloud VPS interfaces don't carry the public IP directly.

## Upgrading an existing project

The compose file requires two keys that older versions of this stack did not write:

- `MIROTALK_JWT_KEY`: MiroTalk 2.1 refuses to start without `JWT_KEY`.
- `MIROTALK_API_KEY_SECRET`: without `API_KEY_SECRET` the image uses a default key that MiroTalk's
  documentation prints. A server deployed before this key existed answers its REST API
  (`/api/v1/stats`, and the endpoints that create meeting links and join tokens) to anyone who
  sends that default, until it is redeployed with a key of its own.

A project that added this stack before one of them existed has no such line. Its next deploy does
not start the container: it reports `mirotalk` as failed with
`required variable MIROTALK_API_KEY_SECRET is missing a value` (or `MIROTALK_JWT_KEY`) and exits
non-zero. A whole-server deploy still updates the other stacks, but runs none of their after-deploy
hooks. Before that deploy, add what is missing in one of two ways:

- Run `rostok stack add mirotalk -s <server>` again. It generates only the missing keys, keeps
  every other value and re-encrypts the file.
- Or by hand: generate a value of at least 32 characters with `openssl rand -hex 32` for each
  missing key, add `MIROTALK_API_KEY_SECRET=<that value>` (or `MIROTALK_JWT_KEY=<that value>`) to
  the server's `.env`, and run `rostok env encrypt`.

Then commit the `.env.age` file and run `rostok deploy <server>`. The deploy recreates the
`mirotalk` container, which ends the calls in progress. To check the result, send the old default
key to `https://<MIROTALK_DOMAIN>/api/v1/stats` in the `authorization` header: the answer is 403.

Changing the JWT key later only ends the tokens MiroTalk has already handed out; they last an hour.
Changing the API key later only affects your own scripts that call the API.

The TURN username and credential are required in the same way. `rostok stack add` has always
generated both, so only an `.env` edited by hand can lack them.

## Host firewall

coturn uses `network_mode: host` so it binds directly on the host interface.
Public-inbound ports required:

- `3478/udp` — STUN + TURN control + UDP relay
- `5349/tcp` — TURN over TLS (fallback for networks blocking UDP)
- `10000-20000/udp` — relay port range

On Hetzner Cloud, add these to the server's firewall in the Cloud Console (or
via the API). On hosts running `firewalld`/`nftables`, allow the same.

## What the relay refuses

MiroTalk sends the TURN username and credential to every browser that joins a room, and a room
needs no login. So treat that login as known to anyone who has opened a room: they can use the
relay, also outside a call, to send traffic to public addresses.

What they cannot do is reach addresses that only the server itself can reach. coturn runs on the
host's network, so the compose file tells it to refuse these peers:

- loopback (`127.0.0.0/8`, `::1`) and "this network" (`0.0.0.0/8`)
- the private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), which hold the Docker
  networks, and IPv6 unique-local (`fc00::/7`)
- carrier-grade NAT (`100.64.0.0/10`)
- two reserved blocks that are never routed on the internet, though a VPN or proxy tool may put
  a host interface in one (`192.0.0.0/24`, `198.18.0.0/15`)
- link-local (`169.254.0.0/16`, which holds the cloud provider's metadata address, and
  `fe80::/10`)
- multicast, and IPv4 addresses written as IPv6 (`::ffff:0:0/96`)

A client that asks for one of them gets error 403, "Forbidden IP". The server's own public address
stays allowed: two browsers that both need the relay reach each other through it. A service that
listens on that public address is therefore reachable through the relay even when a firewall in
front of the server blocks its port, so bind such a service to a private address or to loopback.

## Secrets in the container log

MiroTalk prints its whole configuration to its log at every start, and that includes the REST API
key (`MIROTALK_API_KEY_SECRET`) and the TURN username and credential in clear text. No setting of
the image turns that line off: `LOGS_DEBUG=false` hides only debug lines, and this one is not.

So whoever can read the log can read both keys:

- anyone who can run `docker logs hl-mirotalk` on the server, which means root and every member
  of the `docker` group;
- if the `victoria-metrics` stack runs on the same server, its log collector copies every
  container's log into VictoriaLogs and keeps it for 14 days. VictoriaLogs takes no password, so
  whoever can query it reads the keys too: the containers on that stack's own `logs` network,
  which by default are only the collector and the store. It is not on the shared `proxy` network.

The TURN login is given to every browser that joins a room anyway (see "What the relay refuses"),
so the log adds nothing there. The API key is the one that matters: with it, anyone can create
meeting links and join tokens. If it has leaked, change `MIROTALK_API_KEY_SECRET` and redeploy;
the copies already in the log store stay until its retention ends.

## TURN over TLS

The browser advertises `turns://<MIROTALK_DOMAIN>:5349` to peers. The
`mirotalk-cert-extract` sidecar watches Traefik's `acme.json` and writes
PEM files to a shared volume that coturn mounts — so Let's Encrypt
renewals propagate automatically.

Why this matters: peer-to-peer WebRTC tries direct UDP first, falls back
to TURN-over-UDP when symmetric NAT blocks it. When the peer's network
blocks UDP entirely (corporate firewalls, some hotel/captive WiFi), the
browser needs `turns://` on TCP 5349. Without it the call hangs
indefinitely with both peers "connected" but no media.

## Backup

None, and none is needed. Rooms are not stored. The one volume, `coturn-certs`, holds certificates
that the `mirotalk-cert-extract` sidecar writes again from Traefik's `acme.json` when it starts.

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
