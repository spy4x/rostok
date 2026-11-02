# Xray

A VPN for people behind a censor that blocks WireGuard and OpenVPN. It runs
[Xray-core](https://github.com/XTLS/Xray-core) with VLESS + Reality: to the censor, a client's
connection looks like an ordinary TLS 1.3 visit to a real foreign site (the decoy), and anyone who
probes the server with that site's name gets the real site back.

## How it fits

- Traefik passes every TLS connection on `:443` whose server name is `XRAY_REALITY_SNI` straight
  to `hl-xray` (a TCP router with TLS passthrough). Every other host keeps going to the HTTP
  routers, so no port is published and no router port forward is needed.
- The whole Xray config is built from `.env` by compose. Nothing is stored and no access log is
  kept, so the stack has no backup.
- The server resolves every name first and refuses traffic to private and LAN addresses, so a
  client cannot reach the host's LAN or its Docker networks, by address or by name. It also
  refuses BitTorrent, whose abuse complaints would reach you.

## Variables

Declared in `+meta.ts`; `rostok stack add xray` writes them to the server's `.env` and generates
the secrets.

| Key                        | Default           | Meaning                                        |
| -------------------------- | ----------------- | ---------------------------------------------- |
| `XRAY_REALITY_SNI`         | `www.samsung.com` | Decoy site; must not be a host Traefik serves  |
| `XRAY_REALITY_PRIVATE_KEY` | generated         | X25519 private key, base64url (secret)         |
| `XRAY_REALITY_SHORT_ID`    | generated         | 16 hex characters every client link carries    |
| `XRAY_CLIENTS`             | one generated     | JSON array of clients, one per person (secret) |

Pick a decoy the censor does not block, with TLS 1.3 and HTTP/2. Check it from the server:

```bash
docker run --rm ghcr.io/xtls/xray-core:26.10.31 tls ping www.samsung.com
```

## Clients

Give every person their own client, so one leaked link can be cut off alone. `XRAY_CLIENTS` is a
JSON array, kept in single quotes in `.env`:

```bash
XRAY_CLIENTS='[{"id":"<uuid>","email":"alice","flow":"xtls-rprx-vision"},{"id":"<uuid>","email":"bob","flow":"xtls-rprx-vision"}]'
```

`email` is only a label. Add or remove an entry, run `rostok env encrypt`, then
`rostok deploy <server> xray`. Removing an entry cuts that person off.

## Links for client apps

Client apps (Happ, v2rayNG, Hiddify, Streisand) import a `vless://` link or its QR code. The link
needs the public key, which the server derives from the private key:

```bash
docker exec hl-xray xray x25519 -i "<XRAY_REALITY_PRIVATE_KEY>"
```

It prints the public key on the `Password` line. Each client's link is:

```text
vless://<id>@<server host>:443?type=tcp&security=reality&encryption=none&flow=xtls-rprx-vision&sni=<XRAY_REALITY_SNI>&fp=chrome&pbk=<public key>&sid=<XRAY_REALITY_SHORT_ID>#<label>
```

`<server host>` is any name whose DNS record points straight at the server (no CDN proxy), or its
IP address. Send each person only their own link, and never post one publicly.

## Troubleshooting

- **Clients time out:** check that the router forwards `:443` to the server and that
  `docker logs hl-xray` shows no config error.
- **`invalid user` in the log:** the client's id is not in `XRAY_CLIENTS`, or the deploy that
  added it has not run.
- **Works for a while, then stops:** the censor may have started blocking the decoy. Pick another
  one, deploy, and send everyone new links.

## Image tags

Each image takes its tag from its own variable; unset, compose uses the default below.
Under `IMAGE_POLICY=pinned`, `rostok stack add` writes the exact version, and
`rostok images update` moves it (see [commands](../../docs/commands.md)).

| Variable         | Default    | Image                                     |
| ---------------- | ---------- | ----------------------------------------- |
| `XRAY_IMAGE_TAG` | `26.10.31` | `ghcr.io/xtls/xray-core` (service `xray`) |
