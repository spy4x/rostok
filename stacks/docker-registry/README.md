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
docker pull registry.${DOMAIN}/my-image:tag
docker push registry.${DOMAIN}/my-image:tag
```

## Resources

- [Docker Registry Docs](https://docs.docker.com/registry/)
- [docker-registry-ui](https://github.com/Joxit/docker-registry-ui)
