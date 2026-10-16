# Docker Registry

Private Docker image registry with web UI.

## Features

- Store and serve custom Docker images
- A login on every request: the registry has one user and no anonymous access
- Image deletion enabled (`REGISTRY_STORAGE_DELETE_ENABLED=true`), for the signed-in user
- Web UI at registry subdomain (docker-registry-ui)
- Garbage collection support

## Access

- Registry: `https://${DOCKER_REGISTRY_DOMAIN}/v2/`
- Web UI: `https://${DOCKER_REGISTRY_DOMAIN}`

The web UI forwards `/v2` to the registry, so both are on the same public address. The registry
itself asks for the login, so a request without one gets `401` whichever way it arrives.

## Signing in

The user is `DOCKER_REGISTRY_USER` (default `admin`) and the password is
`DOCKER_REGISTRY_PASSWORD`. `rostok stack add docker-registry` generates the password and writes
both to the server's `.env`; read them there.

- **Docker**, on every machine that pushes or pulls, including the servers that run your images:

  ```bash
  docker login ${DOCKER_REGISTRY_DOMAIN}
  docker push ${DOCKER_REGISTRY_DOMAIN}/my-image:tag
  docker pull ${DOCKER_REGISTRY_DOMAIN}/my-image:tag
  ```

- **Web UI**: open `https://${DOCKER_REGISTRY_DOMAIN}`. The browser asks for the user and
  password the first time the page reads the registry.

At deploy, `before.deploy.ts` hashes the password with bcrypt and writes `auth/htpasswd` next to
`compose.yml`; the registry reads that file. No container gets the plain password. To change the
password, change it in `.env` and deploy again: the registry reads the new file without a
restart, and the old password stops working.

Deletion stays on. It needs the login like every other request, and the registry's garbage
collection has nothing to remove without it.

## Upgrade note: the registry now needs a login

Before this change the registry accepted every request, so anyone who knew the address could
list, push, replace and delete images. An existing deployment has to do three things:

1. Run `rostok stack add docker-registry --server=<server>` again. It keeps every value already
   in `.env` and adds `DOCKER_REGISTRY_USER` and a generated `DOCKER_REGISTRY_PASSWORD`. Then
   `rostok env encrypt` and commit. Until the two keys exist, the deploy stops in this stack's
   hook and says which key is missing.
2. Deploy. The images already stored are kept.
3. Run `docker login ${DOCKER_REGISTRY_DOMAIN}` on every machine that pushes or pulls: your own,
   your CI, and each server that runs images from this registry (as the user that pulls there).
   Until then their pushes and pulls fail with `no basic auth credentials`.

Because the registry was open, look through the image list once for a repository or tag you do
not recognise, and push again any image you cannot vouch for.

## Resources

- [Docker Registry Docs](https://docs.docker.com/registry/)
- [docker-registry-ui](https://github.com/Joxit/docker-registry-ui)

## Variables

Declared in `+meta.ts`. Requires the `traefik` stack. Server-level keys (`DOMAIN`, `VOLUMES_PATH`) are shared by every stack.

| Key                        | Default              | Meaning                                     |
| -------------------------- | -------------------- | ------------------------------------------- |
| `DOCKER_REGISTRY_DOMAIN`   | `registry.${DOMAIN}` | Public host of the web UI and registry name |
| `DOCKER_REGISTRY_USER`     | `admin`              | User name of the registry's login           |
| `DOCKER_REGISTRY_PASSWORD` | generated, secret    | Password of the login; only the hook reads  |

## Image tags

Each image takes its tag from its own variable; unset, compose uses the default below.
Under `IMAGE_POLICY=pinned`, `rostok stack add` writes the exact version, and
`rostok images update` moves it (see [commands](../../docs/commands.md)).

| Variable                       | Default  | Image                                              |
| ------------------------------ | -------- | -------------------------------------------------- |
| `DOCKER_REGISTRY_IMAGE_TAG`    | `2`      | `registry` (service `docker-registry`)             |
| `DOCKER_REGISTRY_UI_IMAGE_TAG` | `latest` | `joxit/docker-registry-ui` (service `registry-ui`) |
