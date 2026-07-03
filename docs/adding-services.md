# Adding Services

Complete workflow for integrating new services into the infrastructure.

## Quick Checklist

1. ☐ Create stack in `stacks/{name}/` with compose.yml
2. ☐ Add stack to server's `config.json`
3. ☐ Add environment variables to `.env` and `.env.example`
4. ☐ Create backup config (if service has persistent data)
5. ☐ Deploy and verify
6. ☐ Add monitoring to Gatus

## Service Definition

Create `stacks/myservice/compose.yml`. **Important: never add a `default` network unless the service communicates with other containers within the same stack** (e.g., app ↔ db). Single-service stacks must use this pattern:

```yaml
networks:
  proxy:
    external: true
  default:
    external: true
    name: proxy

services:
  myservice:
    image: myservice/myservice:latest
    container_name: myservice
    volumes:
      - ${VOLUMES_PATH}/myservice:/data
    networks: [proxy]
    restart: unless-stopped
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.myservice.rule=Host(`myservice.${DOMAIN}`)"
      - "traefik.http.routers.myservice.entrypoints=websecure"
      - "traefik.http.routers.myservice.tls.certresolver=myresolver"
```

Add to `servers/{server}/config.json`:
```json
{
  "stacks": [
    {"name": "traefik"},
    {"name": "myservice"}
  ]
}
```

### Server-Specific Configuration

For server-specific settings, use environment variables or config overrides in `servers/{server}/configs/myservice/`.

### Deploying Same Stack Multiple Times

Use `deployAs` to deploy the same stack with different names:

```json
{
  "stacks": [
    {"name": "nginx", "deployAs": "homepage"},
    {"name": "nginx", "deployAs": "blog"}
  ]
}
```
```

## Environment Variables

Add to `servers/{server}/.env`:
```bash
#region MyService
MYSERVICE_API_KEY=actual_secret_value
#endregion
```

Add to `servers/{server}/.env.example`:
```bash
#region MyService
MYSERVICE_API_KEY=YOUR_API_KEY_HERE  # Get from https://myservice.com/settings
#endregion
```

## Backup Configuration

**Required for all services with persistent data.**

Create `stacks/myservice/backup.ts`:

```typescript
import { BackupConfig } from "@scripts/backup"

export default {
  name: "myservice",
  sourcePaths: "default",        // Backs up ${VOLUMES_PATH}/myservice
  containers: { stop: "default" } // Stops container "myservice"
} as BackupConfig
```

**Skip backup config entirely** for stateless services (config-only via env vars, no volumes).

## Pre-Deploy Scripts (before.deploy.ts)

Some services need configuration generated before deployment. Create `stacks/myservice/before.deploy.ts`:

```typescript
// This script runs during deployment, before rsync to the server
// Environment variables from .env and .env.root are available
// DEPLOY_AS env var contains the deployment name (for renamed stacks)

const templateFile = new URL("config.template", import.meta.url).pathname
const outputFile = new URL("config.properties", import.meta.url).pathname

// Read template and substitute environment variables
const template = await Deno.readTextFile(templateFile)
const output = template.replace(/\${([^}]+)}/g, (_match, envVarName) => {
  const value = Deno.env.get(envVarName.trim())
  if (value === undefined) {
    throw new Error(`Environment variable '${envVarName.trim()}' not found.`)
  }
  return value
})
await Deno.writeTextFile(outputFile, output)

console.log(`Generated '${outputFile}' from template`)
```

**Use cases**:
- Generate config files from templates with env var substitution
- Create dynamic configuration based on server settings
- Pre-process files that can't use Docker env var expansion

**Server-specific before.deploy.ts**: Place in `servers/{server}/configs/{service}/before.deploy.ts` for server-specific preprocessing.

### Advanced Backup Configs

**Multiple paths**:
```typescript
export default {
  name: "myservice",
  sourcePaths: [
    "${VOLUMES_PATH}/myservice/data",
    "${VOLUMES_PATH}/myservice/config"
  ],
  containers: { stop: ["myservice", "myservice-worker"] }
} as BackupConfig
```

**Shared service deployed on multiple servers**:
```typescript
export default {
  name: "myservice",
  destName: `myservice-\${SERVER_NAME}`, // Unique repo name per server
  sourcePaths: "default",
  containers: { stop: "default" }
} as BackupConfig
```

**Non-service backups** (server-specific folders):
Create `servers/{server}/configs/backup/mybackup.backup.ts` instead.

See [backup README](../scripts/backup/README.md) for full options.

## Deployment

```bash
deno task deploy <server>

# Verify (deno task ssh <server> docker ps to skip interactive)
deno task ssh <server>
cd /opt/apps
docker compose ps
docker compose logs -f myservice
```

## Monitoring

Add to `servers/{server}/configs/gatus.yml`:

```yaml
endpoints:
  - name: MyService
    url: "https://myservice.yourdomain.com"
    interval: 5m
    conditions:
      - "[STATUS] == 200"
```

[Gatus docs](https://github.com/TwiN/gatus#configuration) for advanced checks.

## Common Patterns

### Service + Database

```yaml
services:
  myservice:
    image: myservice/myservice:latest
    depends_on: [myservice-db]
    environment:
      - DB_HOST=myservice-db
      - DB_PASSWORD=${MYSERVICE_DB_PASSWORD}
      
  myservice-db:
    image: postgres:16-alpine
    container_name: myservice-db
    volumes:
      - ${VOLUMES_PATH}/myservice/db:/var/lib/postgresql/data
    environment:
      - POSTGRES_PASSWORD=${MYSERVICE_DB_PASSWORD}
    restart: unless-stopped
```

### With Basic Auth

```yaml
labels:
  - "traefik.http.routers.myservice.middlewares=auth"
  - "traefik.http.middlewares.auth.basicauth.users=${BASIC_AUTH_USER}:${BASIC_AUTH_PASSWORD}"
```

See [Traefik middleware docs](https://doc.traefik.io/traefik/middlewares/http/overview/).

## Troubleshooting

**Container won't start**:
```bash
docker compose logs myservice
```

**Can't access via domain**:
```bash
docker compose logs traefik | grep myservice  # Check Traefik discovery
dig myservice.yourdomain.com                  # Verify DNS
```

**Backup fails**:
```bash
cd servers/<server>
deno run --env-file=.env -A ../../scripts/backup/+main.ts
```

See [troubleshooting guide](troubleshooting.md) for more solutions.
