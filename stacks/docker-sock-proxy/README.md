# Docker Socket Proxy

Secure proxy for the Docker API socket. Restricts which API endpoints containers can access via Docker socket.

Prevents mounting `/var/run/docker.sock` directly into containers like Watchtower or Portainer.

## Access

Internal service only (no Traefik labels). Reachable on the `proxy` network at `hl-docker-sock-proxy:2375`.

## Variables

None: `rostok stack add docker-sock-proxy` asks nothing. The allowed
endpoints are fixed in `compose.yml`. No Traefik route, so no `traefik` stack
is needed.

## Security

There is no authentication. Any container on the `proxy` network can reach
`hl-docker-sock-proxy:2375`, and the permission model below allows exec, kill
and container create, which is close to root on the host. Attach only
containers you trust to that network.

## Configuration

Env vars are documented upstream:
https://github.com/Tecnativa/docker-socket-proxy

### Permission Model

| Setting        | Value | Reason                                               |
| -------------- | ----- | ---------------------------------------------------- |
| `CONTAINERS`   | 1     | Agent-server creates/starts/stops sandbox containers |
| `IMAGES`       | 1     | Pull agent-server images on demand                   |
| `NETWORKS`     | 1     | Connect sandbox containers to networks               |
| `VOLUMES`      | 1     | Mount volumes into sandbox containers                |
| `EVENTS`       | 1     | Stream Docker events for real-time state             |
| `AUTH/SECRETS` | 0     | Not needed — explicit deny                           |
| `BUILD/COMMIT` | 0     | Prevent arbitrary image builds                       |
| `SWARM/NODES`  | 0     | No swarm access needed                               |

## Usage

Other containers set `DOCKER_HOST=tcp://hl-docker-sock-proxy:2375` instead of mounting `/var/run/docker.sock`.

## Resources

- [GitHub: Tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy)
