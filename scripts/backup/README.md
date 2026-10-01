# Homelab Backup System

A modular TypeScript backup system using Deno and Restic for backing up homelab services.

## Architecture

The backup system is organized into clean, modular components:

### Core Files

- **`+main.ts`** - Main script containing backup orchestration logic
- **`+lib.ts`** - Shared utilities and environment variable helpers

### Source Modules (`src/`)

- **`types.ts`** - TypeScript types and interfaces
- **`config.ts`** - Configuration loading and validation logic
- **`operations.ts`** - Core backup operations (Docker, Restic, file management)
- **`reporting.ts`** - Notification and reporting functionality

### Configuration Files

Backup configurations are loaded from two locations:

1. **`stacks/*/backup.ts`** - Service backup configurations (co-located with service definitions)
2. **`servers/{name}/configs/backup/*.backup.ts`** - Non-service backups (server-specific folders, etc.)

The system automatically discovers and merges configurations from both locations.

## Features

- **Modular Design**: Each concern is separated into its own module
- **Type Safety**: Full TypeScript support with comprehensive type definitions
- **Error Handling**: Robust error handling with detailed reporting
- **Docker Integration**: Automatic container stop/start during backups
- **Ownership Management**: Handles file ownership for proper backup access
- **Repository Management**: Automatic Restic repository initialization
- **Size Reporting**: Calculates and reports backup repository sizes
- **Configurable Retention**: Configurable backup retention policies

## Usage

### Manual Run

```bash
# Run the backup process
deno run -A +main.ts

# With environment file
deno run --env-file=/path/to/.env -A +main.ts

# Check TypeScript compilation
deno check +main.ts
```

### Cron Job

It has to be installed for root via `sudo crontab -e` to allow changing ownership without password prompts.

```bash
# Daily at 2:30am
30 2 * * * SSH_USER=$USER /path/to/deno run --env-file=/path/to/.env -A /path/to/+main.ts >> /path/to/backup.log 2>&1
```

## Running a pinned release

Run the runner from a git checkout of a release tag, not from a hand copy or a dev checkout:

```bash
git clone --branch v<version> --depth 1 https://github.com/spy4x/rostok <disk>/rostok/backup-runner
deno run -A --env-file=<server env> <disk>/rostok/backup-runner/scripts/backup/+main.ts
```

To upgrade, clone the new tag next to the old one and point the cron job at it.

## Environment Variables

Read from the `--env-file` (or the shell) by `+main.ts` and `src/+lib.ts`:

Required:

- `SSH_USER` - user that owns the data; read from the server `.env`, not the shell's own `$USER`
- `PATH_APPS` - the apps directory (`stacks/` and `configs/backup/` are read from it)
- `VOLUMES_PATH` - where service data lives (default backup source `${VOLUMES_PATH}/<name>`)
- `PATH_SYNC` - base path for synced data
- `SERVER_NAME` - server name, used in reports and `destName` templates
- `PATH_BACKUPS` - where the restic repositories are written
- `BACKUPS_PASSWORD` - password of the restic repositories
- `NTFY_URL_BACKUPS` - ntfy topic URL for the report
- `NTFY_TOKEN_BACKUPS` - ntfy bearer token

Optional:

- `PATH_MEDIA` - media path (home server only)
- `HEALTHCHECKS_BACKUP_URL` - healthchecks.io-style ping URL

## How stacks are stopped and restarted

Before stopping a stack, the runner finds its running containers and reads their compose labels
(`com.docker.compose.project`, `.project.config_files`). Stop, start and the `up -d` fallback all
use exactly that project name and those compose files, run from the apps root (the part of the
compose path before `/stacks/<name>/compose.yml`, where `rostok deploy` runs compose and keeps
`.env.root` and `.env`; compose's own `working_dir` label is the stack directory, so it is not
used). Env files are passed as `--env-file=.env.root --env-file=.env` when both exist. So a
server deployed with `rostok deploy` (`<disk>/rostok/apps/stacks/<name>/compose.yml`) is handled
correctly even though the runner lives elsewhere.

Docker runs with a cleaned environment: only `PATH`, `XDG_RUNTIME_DIR`, the `DOCKER_*` variables
and `HOME=/home/<SSH_USER>`. Compose gives its own environment priority over `--env-file`, and
the runner's env file always sets `VOLUMES_PATH` and `PATH_APPS`, so without the cleanup a
rebuilt stack would mount the runner's paths instead of the deployed ones.

- No container of the stack is running: nothing is stopped, and nothing is started afterwards. No
  path is guessed. A stack whose containers all exist but are stopped stays stopped; earlier
  versions of the runner started it.
- `start` fails because a container vanished (Watchtower): `up -d` runs from the apps root with
  `--env-file=.env.root --env-file=.env`, the same as `rostok deploy`. If a recorded compose file
  or one of those env files no longer exists, `up -d` does not run: the stack stays stopped and
  the backup is reported as failed, rather than rebuilding the stack from wrong config. An old
  layout with only `.env` at the apps root therefore never gets an automatic rebuild.
- The containers of one project carry different compose file lists (a deploy override changed
  only some services, so only those were recreated with it): the runner uses the longest list,
  as long as every other list fits inside it in the same order. Lists that do not fit together
  fail the backup without stopping anything; recreate the stack from its current files.
- A running container looks like it belongs to the stack (same project name or stack directory) but
  no compose file of it ends in `/stacks/<name>/compose.yml`: the backup fails instead of copying
  the data live.
- The stack's containers come from more than one compose project or apps root: the backup fails
  without stopping anything.

A `rostok backup` command that replaces this runner is still planned in
[#297](https://github.com/spy4x/rostok/issues/297). This fix is smaller and blocks moving the home
server to the rostok layout, so it ships first.

## Configuration Structure

Each backup configuration file should export a default `BackupConfig` object:

```typescript
import { BackupConfig, PATH_APPS } from "../+lib.ts"

const backupConfig: BackupConfig = {
  name: "service-name",
  sourcePaths: [`${PATH_APPS}/.volumes/service-name`],
  pathsToChangeOwnership: [`${PATH_APPS}/.volumes/service-name`],
  containers: {
    stop: ["container1", "container2"],
  },
}

export default backupConfig
```

### Configuration Options

- `name` - Backup name (used for repository naming)
- `sourcePaths` - Paths to backup (use "default" for `${PATH_APPS}/.volumes/${name}`)
- `pathsToChangeOwnership` - Paths to change ownership before backup (optional)
- `containers.stop` - Docker containers to stop during backup (use "default" for `[name]`)

## Adding New Services

When adding a new service with persistent data:

1. **Create backup config** at `stacks/{service}/backup.ts`:
   ```typescript
   import { BackupConfig } from "@scripts/backup"

   export default {
     name: "myservice",
     sourcePaths: "default", // Uses ${VOLUMES_PATH}/myservice
     containers: { stop: "default" }, // Stops container "myservice"
   } as BackupConfig
   ```

2. **For shared services** deployed on multiple servers, use dynamic naming:
   ```typescript
   export default {
     name: "gatus",
     destName: `gatus-\${SERVER_NAME}`, // Unique repo per server
     sourcePaths: "default",
     containers: { stop: "default" },
   } as BackupConfig
   ```

3. **Skip backup config entirely** for stateless services (no volumes, config via env vars only)

4. **For non-service backups** (server-specific folders), create `servers/{name}/configs/backup/mybackup.backup.ts` instead

The backup script automatically discovers configs from both locations during execution.

## Backup Process

1. **Load Configurations** - Dynamically import all `*.backup.ts` files
2. **Validate Configurations** - Check paths exist and normalize settings
3. **For Each Backup**:
   - Stop Docker containers
   - Change file ownership if configured
   - Initialize Restic repository if needed
   - Perform backup with integrity checks
   - Clean up old backups (7 daily, 4 weekly, 3 monthly)
   - Restart Docker containers
4. **Calculate Repository Sizes** - Get disk usage for each repository
5. **Generate Reports** - Console output and NTFY notification

## Error Handling

The system provides comprehensive error handling:

- Configuration validation errors
- Path existence checks
- Docker command failures
- Restic operation failures with specific exit code handling
- Size calculation errors
- Notification failures

All errors are logged with context and reported in the final notification.

## Restore Process

To restore files from a restic backup:

```bash
# Set password environment variable
export RESTIC_PASSWORD="your-backup-password"

# List snapshots
restic -r /path/to/repo snapshots

# Restore a snapshot
restic -r /path/to/repo restore <snapshot-id> --target <target-dir>

# Restore specific files
restic -r /path/to/repo restore <snapshot-id> --target <target-dir> --include "path/to/specific/file"
```

## Security Notes

For the chown operations to work without sudo prompts, configure sudoers:

```bash
sudo visudo
```

Add line (replace `username` with your actual username):

```
username ALL=(ALL) NOPASSWD: /usr/bin/chown
```

**Warning**: This is a security consideration. Ensure you understand the implications.

## Refactoring Benefits

The refactored architecture provides:

- **Simplified Structure**: Main logic consolidated in `+main.ts` with support modules in `src/`
- **Better Separation of Concerns**: Each module in `src/` has a single responsibility
- **Improved Maintainability**: Easier to modify specific functionality
- **Enhanced Testability**: Functions are focused and easier to unit test
- **Type Safety**: Comprehensive TypeScript typing throughout
- **Better Error Handling**: More granular error handling and reporting
- **Code Reusability**: Modular design allows for better code reuse
- **Cleaner Organization**: Logical file structure without redundant prefixes
- **Easier Debugging**: Clear module boundaries make issues easier to trace

## Troubleshooting

- Check logs for specific error messages
- Ensure all required environment variables are set
- Verify Deno and restic are installed and accessible
- Check file permissions for backup paths
- Validate Docker container names match actual running containers
