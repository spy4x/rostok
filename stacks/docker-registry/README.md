# Docker Registry

Private Docker image registry with web UI.

## Features

- Store and serve custom Docker images
- Image deletion enabled (`REGISTRY_STORAGE_DELETE_ENABLED=true`)
- Web UI at registry subdomain (docker-registry-ui)
- Garbage collection support

## Access

- Registry: `https://registry.${DOMAIN}/v2/`
- Web UI: `https://registry.${DOMAIN}`

## Usage

```bash
docker pull ${DOCKER_REGISTRY_DOMAIN}/my-image:tag
docker push ${DOCKER_REGISTRY_DOMAIN}/my-image:tag
```

## Resources

- [Docker Registry Docs](https://docs.docker.com/registry/)
- [docker-registry-ui](https://github.com/Joxit/docker-registry-ui)

## Variables

Declared in `+meta.ts`. Requires the `traefik` stack. Server-level keys (`DOMAIN`, `VOLUMES_PATH`) are shared by every stack.

| Key                      | Default              | Meaning                                     |
| ------------------------ | -------------------- | ------------------------------------------- |
| `DOCKER_REGISTRY_DOMAIN` | `registry.${DOMAIN}` | Public host of the web UI and registry name |
