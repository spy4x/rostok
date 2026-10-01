# Cloudflared - Cloudflare Tunnel

Cloudflared creates a secure tunnel to Cloudflare's network, allowing you to expose your homelab services without a static IP address or opening ports on your router. It works seamlessly with Traefik to route traffic through Cloudflare Tunnel.

## Features

- **No Static IP Required**: Perfect for users with dynamic IP addresses
- **No Port Forwarding**: No need to open ports on your router
- **DDoS Protection**: Built-in protection from Cloudflare
- **Encrypted Tunnel**: All traffic is encrypted through Cloudflare's network
- **Works with Traefik**: Integrates with your existing reverse proxy setup

## How It Works

1. Cloudflared creates an outbound-only tunnel to Cloudflare's network
2. Cloudflare routes incoming requests through the tunnel to your server
3. The requests reach Traefik on your homelab
4. Traefik routes the request to the appropriate service container

## Prerequisites

1. A Cloudflare account (free tier works)
2. A domain added to Cloudflare
3. DNS records managed by Cloudflare

## Setup Instructions

### 1. Create a Cloudflare Tunnel

1. Log in to your [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Go to **Zero Trust** > **Networks** > **Tunnels**
3. Click **Create a tunnel**
4. Choose **Cloudflared** as the tunnel type
5. Give it a name (e.g., "homelab")
6. Click **Save tunnel**
7. Copy the tunnel token that appears

### 2. Configure Environment Variables

Add the tunnel token to your server's `.env` file:

```bash
# Cloudflared - Cloudflare Tunnel
CLOUDFLARED_TUNNEL_TOKEN=your_tunnel_token_here
CLOUDFLARED_IMAGE_TAG=latest
CLOUDFLARED_CPU_LIMIT=0.5
CLOUDFLARED_MEM_LIMIT=256M
```

`rostok stack add cloudflared` asks for the token and writes these.

### 3. Configure Tunnel Routes

In the Cloudflare Dashboard, configure your tunnel to route traffic:

1. Go to your tunnel's **Public Hostname** tab
2. Add routes for your services:
   - **Subdomain**: `example` (e.g., jellyfin, immich, etc.)
   - **Domain**: `yourdomain.com`
   - **Service**:
     - **Type**: `HTTP`
     - **URL**: `traefik:443` or `traefik:80`

Example routes:

- `jellyfin.yourdomain.com` → `http://traefik:80` → Traefik routes to jellyfin container
- `immich.yourdomain.com` → `http://traefik:80` → Traefik routes to immich container
- `*.yourdomain.com` → `http://traefik:80` → Traefik routes based on subdomain

### 4. Update DNS (if needed)

Cloudflare will automatically create CNAME records for your tunnel routes. Verify they exist:

1. Go to **DNS** > **Records** in Cloudflare Dashboard
2. Ensure your subdomains point to your tunnel (should be automatic)

### 5. Deploy the Stack

```bash
deno task deploy home cloudflared
```

## Configuration Options

### Resource Limits

Adjust CPU and memory limits in your `.env`:

```bash
CLOUDFLARED_CPU_LIMIT=0.5    # CPU cores
CLOUDFLARED_MEM_LIMIT=256M   # Memory
```

### Multiple Tunnels

For multiple servers, create separate tunnels with different tokens:

```bash
CLOUDFLARED_TUNNEL_TOKEN=token_for_home_server
```

## Traefik Integration

Cloudflared works with your existing Traefik setup. Each service should have Traefik labels as usual:

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.myservice.rule=Host(`myservice.${DOMAIN}`)"
  - "traefik.http.routers.myservice.tls.certresolver=myresolver"
```

The flow is:

```
Internet → Cloudflare → Cloudflared Tunnel → Traefik → Service Container
```

## Security Considerations

1. **Enable HTTPS**: Cloudflare encrypts traffic to the tunnel, but enable HTTPS in Traefik for end-to-end encryption
2. **Access Policies**: Use Cloudflare Access to add authentication before traffic reaches your services
3. **Rate Limiting**: Configure Cloudflare's rate limiting to protect your services
4. **Firewall Rules**: You can still block unwanted traffic at the Cloudflare level

## Troubleshooting

### Tunnel Not Connecting

Check logs:

```bash
docker logs cloudflared
```

Common issues:

- Invalid tunnel token
- Network connectivity issues
- Cloudflare service outage (check status.cloudflare.com)

### Services Not Accessible

1. Verify tunnel routes are configured correctly in Cloudflare Dashboard
2. Check Traefik is routing correctly: `docker logs traefik`
3. Ensure service containers have proper Traefik labels
4. Verify DNS records point to your tunnel

### SSL/TLS Issues

If using SSL with Cloudflare:

1. Set SSL/TLS mode to **Full** or **Full (strict)** in Cloudflare Dashboard
2. Ensure Traefik has valid certificates (Let's Encrypt)
3. Check that services are accessible via HTTPS internally

## Alternative: Cloudflare Access

For additional security, enable Cloudflare Access:

1. Go to **Zero Trust** > **Access** > **Applications**
2. Add an application for each service
3. Configure authentication policies (email, Google, GitHub, etc.)
4. Users must authenticate before accessing services

## Resources

- [Cloudflare Tunnel Documentation](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/)
- [Cloudflared GitHub](https://github.com/cloudflare/cloudflared)
- [Traefik Documentation](https://doc.traefik.io/traefik/)

## Notes

- Cloudflared is stateless - no persistent data to backup
- Free tier includes generous bandwidth limits
- Can be used alongside traditional port forwarding if you have a static IP
- Consider using both tunnels for redundancy (Cloudflare tunnel + WireGuard)
