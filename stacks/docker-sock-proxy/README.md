# Docker Socket Proxy

Secure proxy for the Docker API socket. Restricts which API endpoints containers can access via Docker socket.

Prevents mounting `/var/run/docker.sock` directly into containers like Watchtower or Portainer.

## Access

Internal service only (no Traefik labels). Reachable at `hl-docker-sock-proxy:2375`, only from
containers on its own network, `hl-docker-api`. That network is internal (no route out), and
this stack's compose file creates it on deploy.

## Variables

None: `rostok stack add docker-sock-proxy` asks nothing. The allowed
endpoints are fixed in `compose.yml`. No Traefik route, so no `traefik` stack
is needed.

## Security

There is no authentication, and the permission model below allows exec, kill
and container create, which is close to root on the host. So the proxy is not
on the shared `proxy` network, where every container behind Traefik could
reach it. Only containers on `hl-docker-api` can, and a container is there
only when its stack names that network. Attach only containers you trust.

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

A container that needs the Docker API joins `hl-docker-api` as an external
network and sets `DOCKER_HOST=tcp://hl-docker-sock-proxy:2375` instead of
mounting `/var/run/docker.sock`:

```yaml
networks:
  docker-api:
    name: hl-docker-api
    external: true

services:
  my-service:
    environment:
      - DOCKER_HOST=tcp://hl-docker-sock-proxy:2375
    networks:
      - docker-api
```

Deploy `docker-sock-proxy` first: compose refuses to start a stack whose
external network does not exist yet. Keep the consumer on its other networks
(`proxy` for a Traefik route) as before; `hl-docker-api` only adds the way to
the Docker API.

### Upgrading from a release that used `proxy`

Earlier releases put the proxy on the `proxy` network. The next deploy of
this stack moves it to `hl-docker-api`, and a container of your own that
reached `hl-docker-sock-proxy:2375` through `proxy` loses the connection.
Add `hl-docker-api` to that container's compose file as shown above, then
deploy it again.

## Resources

- [GitHub: Tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy)

## Image tags

Each image takes its tag from its own variable; unset, compose uses the default below.
Under `IMAGE_POLICY=pinned`, `rostok stack add` writes the exact version, and
`rostok images update` moves it (see [commands](../../docs/commands.md)).

| Variable                      | Default  | Image                                                         |
| ----------------------------- | -------- | ------------------------------------------------------------- |
| `DOCKER_SOCK_PROXY_IMAGE_TAG` | `latest` | `tecnativa/docker-socket-proxy` (service `docker-sock-proxy`) |
