# WireGuard

VPN for secure remote access to services.

## Features

- Encrypted tunnel to server network
- Access services via internal hostnames
- Mobile and desktop clients
- Low overhead, high performance

## Setup

1. Generate client config on server
2. Import to [WireGuard client](https://www.wireguard.com/install/)
3. Connect to VPN
4. Access services via `http://container-name:port` or configured domains

## Configuration

```bash
WIREGUARD_DOMAIN=vpn.example.com          # Server public host/IP (→ SERVERURL)
WIREGUARD_PEERS=phone,laptop                 # Peer names/count (→ PEERS)
WIREGUARD_DNS=1.1.1.1,8.8.8.8,9.9.9.9         # DNS for clients (→ PEERDNS, has a default)
```

## Client Management

**Add client**:

```bash
docker exec -it wireguard wg-quick addconf peer1
```

**List clients**:

```bash
docker exec -it wireguard wg show
```

**Get QR code**:

```bash
docker exec -it wireguard /app/show-peer peer1
```

## Access

Config files: `${VOLUMES_PATH}/wireguard/config/`

## Variables

Declared in `+meta.ts`; `rostok stack add wireguard` writes them to the server's `.env`. Server-level keys (`TIMEZONE`, `PUID`, `PGID`) are shared by every stack. Point the DNS record of `WIREGUARD_DOMAIN` straight at the server: UDP 51820 cannot pass through a CDN proxy.

| Key                | Default                   | Meaning                                  |
| ------------------ | ------------------------- | ---------------------------------------- |
| `WIREGUARD_DOMAIN` | `vpn.${DOMAIN}`           | Host clients connect to (`SERVERURL`)    |
| `WIREGUARD_PEERS`  | `phone,laptop`            | Peer count or comma-separated peer names |
| `WIREGUARD_DNS`    | `1.1.1.1,8.8.8.8,9.9.9.9` | Resolvers handed to clients              |

## Resources

- [WireGuard Documentation](https://www.wireguard.com/)
- [Docker Image Docs](https://github.com/linuxserver/docker-wireguard)
- [Client Apps](https://www.wireguard.com/install/)
