# Watchtower

Automatic Docker container updates.

## Features

- Monitors Docker Hub for image updates
- Auto-pulls and restarts containers with new images, including containers stuck
  in a restart loop (`--include-restarting`), so a crash caused by a broken image
  heals once upstream publishes a fix
- Configurable schedules
- Notification support

## Configuration

```bash
WATCHTOWER_SCHEDULE=0 0 4 * * *  # Daily at 4 AM (cron format)
WATCHTOWER_CLEANUP=true           # Remove old images
```

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
