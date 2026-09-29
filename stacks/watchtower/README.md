# Watchtower

Automatic Docker container updates.

## Features

- Monitors Docker Hub for image updates
- Auto-pulls and restarts containers with new images, including containers stuck
  in a restart loop (`--include-restarting`), so a crash caused by a broken image
  heals once upstream publishes a fix
- Configurable schedules
- Notification support

## Variables

Declared in `+meta.ts`; `rostok stack add watchtower` writes them to the
server's `.env`. Server-level keys (`PUID`, `PGID`, `DOCKER_GROUP_ID`) are
shared by every stack.

| Key                    | Default | Meaning                    |
| ---------------------- | ------- | -------------------------- |
| `WATCHTOWER_CPU_LIMIT` | `0.5`   | CPU limit of the container |
| `WATCHTOWER_MEM_LIMIT` | `256M`  | Memory limit               |

The check runs every 24 hours and removes old images (`command:` in
`compose.yml`).

## Exclude Containers

Disable auto-update for specific services:

```yaml
services:
  myservice:
    labels:
      - "com.centurylinklabs.watchtower.enable=false"
```

## Manual Update

Trigger immediate update:

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  containrrr/watchtower --run-once
```

## Resources

- [Watchtower Documentation](https://containrrr.dev/watchtower/)
- [Scheduling](https://containrrr.dev/watchtower/arguments/#scheduling)
- [Notifications](https://containrrr.dev/watchtower/notifications/)
