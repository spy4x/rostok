# AGENTS.md — Dev Guidelines (Strict Git Flow)

Guidelines for AI agents working on this homelab infrastructure repository.
This project uses **git worktrees** with a **strict branch-per-feature** flow.
Multiple AI agents may work on different features simultaneously, so breaking
the rules causes conflicts.

---

## 🔴 IMMUTABLE RULE: Branch + Worktree FIRST (ensure, don't assume)

**This is the single most important rule. Violations cause merge conflicts
between parallel AI workers.**

The very first action you take when given any task involving code changes MUST
be to establish a dedicated branch and worktree — either confirming your
harness already gave you one, or creating it. You MUST NOT open any files, read
any source code, explore the codebase, or make any changes in the **main
worktree**. You work inside the dedicated worktree.

"Establish" is not "create unconditionally": check first (see below). Creating a
worktree while already inside one nests a checkout inside a checkout, which is
how this repo previously accumulated orphaned directories git could no longer
see.

### Why this rule is absolute

This repo may have another AI agent working on a different feature in the
`main` worktree at the same time. If you start editing files in `main`,
you will either:

- Clobber their in-progress changes
- Force them to resolve merge conflicts
- Lose your own work when their agent commits

**Creating the branch first is your very first action — not after exploring,
not after understanding the code, not after "figuring out what to do".**

### → Ensure you have a worktree (your first action)

Your harness may have already placed you in one — OpenCode Web gives every
session its own worktree. **Check before creating anything**, or you end up
with a worktree nested inside a worktree.

```bash
# A linked worktree has .git as a FILE. The main repo has it as a DIRECTORY.
if [ -f .git ]; then
  echo "Already in a worktree — work here. Do NOT create another."
else
  # Derive every path from the repo itself, so this works on any machine.
  MAIN=$(realpath "$(dirname "$(git rev-parse --git-common-dir)")")
  WT="$(dirname "$MAIN")/worktrees/$(basename "$MAIN")/<type>/<slug>"
  mkdir -p "$(dirname "$WT")"   # git worktree add does NOT create parent dirs
  git worktree add -b <type>/<slug> "$WT" main
  cd "$WT"
fi
```

Then confirm with `pwd` and `git branch --show-current`.

Two details that matter:

- **`realpath`** collapses symlinked checkout paths to their canonical
  location, so every worktree is registered under one consistent path. This
  repo is reachable as both `~/sync/code/homelab` and
  `~/ssd-2tb/sync/code/homelab`; without `realpath` you get a confusing mix.
- **`mkdir -p`** on the parent — `git worktree add` fails with a bare
  `No such file or directory` when an intermediate dir is missing.

### Worktree directory layout

Worktrees live **outside** the repo, in a sibling `worktrees/<repo>/` directory:

```
~/ssd-2tb/sync/code/               ← wherever you keep repos
├── homelab/                       ← main worktree + .git/ (do NOT edit here)
│   ├── .git/                      ← git data, shared by all worktrees
│   ├── stacks/                    # Service catalog (reusable)
│   │   └── {service}/
│   │       ├── compose.yml
│   │       ├── backup.ts
│   │       └── README.md
│   ├── servers/                   # Server-specific configs + .env
│   ├── scripts/                   # TypeScript automation
│   ├── ansible/                   # Ansible playbooks
│   ├── deno.jsonc                 # Deno configuration
│   └── AGENTS.md                  ← this file
└── worktrees/
    └── homelab/                   ← every worktree for this repo
        ├── feat/add-dark-mode/    ← .git is a FILE pointing at ../../../homelab/.git
        ├── fix/backup-errors/
        └── review/pr-120/
```

The layout is derived, not hardcoded: a repo at `~/projects/foo` gets its
worktrees in `~/projects/worktrees/foo/<type>/<slug>`.

### Branch naming convention (Angular)

```
<type>/<short-kebab-description>
```

| Type        | Use when                                 |
| ----------- | ---------------------------------------- |
| `feat/`     | New feature or enhancement               |
| `fix/`      | Bug fix                                  |
| `refactor/` | Code restructuring (no behaviour change) |
| `chore/`    | Tooling, deps, CI, config                |
| `docs/`     | Documentation only                       |
| `style/`    | Formatting, styling, design tweaks       |
| `ci/`       | CI/CD pipeline changes                   |

Examples:

```
feat/add-dark-mode
fix/backup-errors
refactor/extract-backup-utils
chore/upgrade-deno-version
```

### What about exploration / understanding the codebase first?

NO. Secure a worktree first. Then explore inside it. The sequence is ALWAYS:

```bash
# STEP 1 (mandatory): are you already in one? If not, create it.
[ -f .git ] || {
  MAIN=$(realpath "$(dirname "$(git rev-parse --git-common-dir)")")
  WT="$(dirname "$MAIN")/worktrees/$(basename "$MAIN")/feat/my-task"
  mkdir -p "$(dirname "$WT")"
  git worktree add -b feat/my-task "$WT" main
  cd "$WT"
}

# STEP 2: now explore and make changes
```

Global `~/.config/opencode/AGENTS.md` → "Git workflow → After worktree creation — env setup" covers this; no need to repeat here.

### Rules

- The `.git` directory lives in the **main** worktree and is shared; every
  linked worktree has a `.git` **file** pointing at it
- The worktree path and the branch name are independent — pass the branch to
  `-b` and the path as a separate argument
- Branch names with `/` create subdirectories under `worktrees/<repo>/`
  (e.g. `fix/foo` → `worktrees/homelab/fix/foo/`)
- You cannot check out the same branch in two worktrees at once — always
  create a fresh branch for new work
- Never create a worktree **inside** the repo or inside another worktree
- When done: `git worktree remove <path> && git branch -d <branch>`. If a
  directory outlives its registration, its `.git` file points at a missing
  gitdir and `git worktree prune` can no longer see it — delete it by hand

---

## 📝 Commit Convention (Angular-adapted)

```
<type>(<scope>): <short summary>
```

**Types:** `feat`, `fix`, `refactor`, `chore`, `docs`, `style`, `perf`, `ci`

**Scope:** stack name, server name, or area (e.g. `gatus`, `backup`, `deploy`). Omit if change is broad.

**Summary:** lowercase, no period, imperative mood (e.g. "add", "drop", "fix", "move").

Examples:

```
feat(immich): add hardware transcoding
fix(gatus): correct Healthchecks endpoint URL
refactor: drop freshrss, roundcube stacks
chore(deps): bump traefik to v3.3
```

### Commit message requirements

1. Keep commits small and focused (one logical change per commit).
2. Run `deno task check` before every commit — all checks MUST pass.

---

## 🔄 Pull Requests & Issues

### PR Discipline (MANDATORY)

**A PR MUST exist at all times when working on a task.** Never work without one.

1. **Create the PR immediately** after the first commit — even if the task is incomplete.
2. **Prefix the title with `[WIP]`** if the task is not yet complete.
3. **Update the PR after every human interaction** — if the human gives feedback, comments, or new information, push a new commit and update the PR body.
4. **Remove `[WIP]` only when the task is fully complete** and ready for final review.
5. **Keep the PR body accurate** — reflect the current state, known issues, and next steps.

This ensures the human can always see what's been done, what's pending, and review intermediate progress.

### Creating a PR

```bash
gh pr create --fill
```

If the task references a GitHub issue, include `Fixes #N` or `Closes #N` in
the PR body so the issue auto-closes on merge. If no issue exists yet, create
one first:

```bash
gh issue create --title "<type>(<scope>): <summary>" --body "<description>"
```

If an issue already exists for this feature, link it. Use the same Angular
convention for the issue title as you would for a commit.

**Create the PR immediately after pushing — never ask "do you want a PR?".**
Just run `gh pr create --fill` and report the link.

### Updating an existing PR

Never create a second PR for the same task. Push additional commits to the
same branch and the PR updates automatically.

### Deploy & Verify (REQUIRED)

**Before committing or reporting "done", you MUST:**

1. Deploy the changed service(s) to production: `deno task deploy <server> [stack]`
2. Verify the service starts, stays healthy, and the fix/feature actually works as expected
3. Only after verification passes, commit and push

This applies to any change that affects deployed services (compose files, scripts, configs). Trivial doc-only changes can skip this step.

---

## ✅ Pre-Commit Checklist (MANDATORY)

Before EVERY commit, run:

```bash
deno task check
```

This runs `fmt + lint + type-check + tests`. All checks MUST pass before you
commit. If they don't, fix the issues first.

---

## 🧹 Merge Protocol (Human-in-the-Loop)

**After all changes are done and the PR is created, you DO NOT merge
yourself. You STOP and wait.**

### What you do after pushing + creating PR

1. Stay in the worktree/branch you created.
2. Report to the human with a summary of what was done and a link to the PR.
3. Wait for the human to review the PR and give you instructions.

### When the human says "merge" (or "merge it")

Decide the merge strategy:

| Condition                                                  | Strategy   |
| ---------------------------------------------------------- | ---------- |
| All commits relate to the same feature/issue/fix           | **Squash** |
| Some commits fix independent things that should stay apart | **Rebase** |

Then:

```bash
# Squash (default choice — all commits for one feature):
gh pr merge --squash --delete-branch

# Rebase (commits have independent meaning):
gh pr merge --rebase --delete-branch
```

Then switch back to the repo root and remove the worktree + branch:

```bash
cd $(git rev-parse --show-toplevel)
git worktree remove <type>/<short-description>
git branch -d <type>/<short-description>
```

This prevents stale worktree directories from accumulating.

## 🚀 Quick Start Commands

### Essential Development Commands

```bash
# Run all checks (lint, format, type-check, tests)
deno task check

# Auto-fix all issues
deno task fix

# Individual commands
deno task lint:check     # Check linting issues
deno task lint:fix       # Auto-fix linting issues
deno task fmt:check      # Check formatting
deno task fmt:fix        # Auto-format code
deno task ts:check       # Type-check TypeScript
deno task test           # Run tests
```

### Running Single Tests

```bash
deno test path/to/specific.test.ts     # Run single test file
deno test --watch path/to/test.ts       # Watch mode
```

### Infrastructure Commands

```bash
deno task deploy <server>     # Deploy all services to server
deno task deploy <server> <stack>  # Deploy single stack (e.g. `deno task deploy home plausible`)
deno task ansible <playbook>  # Run Ansible playbooks
deno task backup              # Run backup system
deno task ssh <server> [cmd...]  # SSH into server or run remote command
```

## 📋 Code Style Guidelines

### TypeScript Formatting (from deno.jsonc)

- **Indentation**: 2 spaces (no tabs)
- **Line width**: 100 characters
- **Quotes**: Double quotes only
- **Semicolons**: Omitted (no semicolons)
- **Prose wrap**: Preserve

### Import Patterns

```typescript
// Use relative imports for local modules
import { BackupConfig } from "./+lib.ts"
import { error, success } from "./+lib.ts"

// Use JSR modules for standard library
import { getEnvVar } from "@std/dotenv"

// Use alias imports for shared scripts
import { BackupConfig } from "@scripts/backup"
```

### Naming Convention: `hl-` Prefix

To avoid conflicts with other projects running on the same Docker host (e.g., `fn-*`, `th-*`), **all homelab containers and Traefik router/service names must use the `hl-` prefix**:

```yaml
# Good
container_name: hl-monica
traefik.http.routers.hl-monica.rule=Host(`crm.${DOMAIN}`)
traefik.http.services.hl-monica.loadbalancer.server.port=80

# Bad (risk of conflict with other projects)
container_name: monica
traefik.http.routers.monica.rule=Host(`crm.${DOMAIN}`)
```

This applies to ALL compose.yml files in `stacks/`. Middleware names (e.g., `auth`) do NOT get the prefix since they're shared definitions on the Traefik container.

### File Naming Conventions

- **TypeScript files**: `kebab-case.ts` (e.g., `backup-config.ts`)
- **Main entry files**: `+main.ts` (Deno convention)
- **Library files**: `+lib.ts` (Deno convention)
- **Config files**: `config.json`, `compose.yml`
- **Backup configs**: `{service-name}.backup.ts`

### Type Definitions

```typescript
// Use interfaces for object shapes
export interface BackupContext {
  serverName: string
  backupsOutputBasePath: string
  // Optional properties with ?
  healthchecksUrl?: string
}

// Use enums for constants
export enum BackupStatus {
  IN_PROGRESS = 1,
  SUCCESS = 2,
  ERROR = 3,
}

// Use type for complex shapes
export type BackupConfigState = BackupConfig & {
  fileName: string
  status: BackupStatus
  error?: string
}
```

### Function Patterns

```typescript
// Export named functions with clear names
export function success(...args: unknown[]) {
  console.log(`%c${new Date().toISOString()} ${args.join(" ")}`, "color: green; font-weight: bold")
}

// Use async/await for async operations
export async function runCommand(
  cmd: string[],
  options?: { sudo?: boolean; cwd?: string },
): Promise<{ success: boolean; output: string; error: string }> {
  // Implementation
}

// Default exports for config objects
const backupConfig: BackupConfig = {
  name: "vaultwarden",
  sourcePaths: "default",
}
export default backupConfig
```

## 🛠️ Environment Variable Management

Uses **age64** — per-value encryption with age. Each secret encrypted independently.
Only changed values show in `git diff` — no more 200-line re-encryption noise.

### Encryption Setup (Required)

**Before working with .env files, you MUST set up encryption:**

1. **Install age** (requires sudo on Linux):
   ```bash
   # macOS
   brew install age
   # Linux
   sudo apt install age    # Debian/Ubuntu
   sudo dnf install age    # Fedora/RHEL
   ```

2. **Generate age key** (one-time):
   ```bash
   mkdir -p .age && age-keygen -o .age/key.txt
   ```
   The public key in `.age/key.txt` comment is your recipient.

3. **Install git hooks for automation**:
   ```bash
   deno task hooks:install              # Auto encrypt/decrypt on git ops
   ```

### Working with Environment Files

**Two files per server:**

1. **`servers/{name}/.env.age`** — committed, has `KEY=age64:base64...` for secrets
2. **`servers/{name}/.env.example`** — committed, placeholders for documentation
3. **`servers/{name}/.env`** — **gitignored**, decrypted plaintext for deploy

**Workflow:**

```bash
# Decrypt .env.age → .env (for editing or deploy)
deno task env:decrypt

# Edit env vars
vim servers/home/.env

# Re-encrypt (only changed values get new ciphertext)
deno task env:encrypt

# Commit
git add servers/home/.env.age
git commit -m "fix(env): update CALDAV_PASSWORD"
```

**Why not SOPS anymore?** SOPS re-encrypts every value on every run → every `.env.age`
line changes, even for untouched values. This made PRs unreadable and caused merge
conflicts on unrelated keys. age64 encrypts each value independently — only the
line you changed differs in the commit.

### Core Operations

```bash
deno task env:encrypt      # .env → .env.age (diff-based, only changed values)
deno task env:decrypt      # .env.age → .env (decrypts age64 values)
```

### .env.example Format

```bash
#region ServiceName
# Database password for ServiceName
# Generate with: head -c 32 /dev/urandom | base64 | tr -d '=' | head -c 32
SERVICE_DB_PASSWORD=REPLACE_WITH_SECURE_PASSWORD
#endregion
```

### .env Format

```bash
#region ServiceName
SERVICE_DB_PASSWORD=abC123...32charSecureString
#endregion
```

**Default username:** `spy4x`

### Git Hooks Automation

The git hooks provide automatic encryption/decryption per worktree:

- **pre-commit**: Auto-encrypts .env → .env.age before commit
- **post-checkout**: Auto-decrypts .env.age → .env after branch switch
- **post-merge**: Auto-decrypts .env.age → .env after merge

**Hook Management:**

```bash
deno task hooks:install          # Install hooks (run from main repo, not worktree)
```

## 🏗️ Service Addition Guidelines

Every new service MUST include:

### 1. Stack Definition (`stacks/{name}/compose.yml`)

- Follow existing patterns (networks, Traefik labels, resource limits)
- Container names must match stack name
- Add to server's `config.json` stacks array

### 2. Backup Configuration (`stacks/{name}/backup.ts`)

```typescript
import { BackupConfig } from "@scripts/backup"

const backupConfig: BackupConfig = {
  name: "service-name",
  sourcePaths: "default", // or custom paths
  containers: {
    stop: "default", // or ["container1", "container2"]
  },
}

export default backupConfig
```

**Skip backup configs** for stateless services (no persistent volumes).

### 3. Documentation (`stacks/{name}/README.md`)

- Service description and purpose
- Setup instructions
- Configuration notes
- Troubleshooting tips

### 4. Authentication Protection

**Every non-public service MUST be protected by auth.** Choose the right layer:

- **Authelia SSO** (preferred): Use `middlewares=authelia@file` in Traefik labels. Add user in `servers/home/configs/authelia/users.yml` and add domain rule in `servers/home/configs/authelia/configuration.yml`:
  ```yaml
  - "traefik.http.routers.hl-SERVICENAME.middlewares=authelia@file"
  ```

- **Basic Auth** (fallback): Use `middlewares=auth` for services without their own login:
  ```yaml
  - "traefik.http.routers.hl-SERVICENAME.middlewares=auth"
  ```
  Basic auth credentials are shared from Traefik's `BASIC_AUTH_USER`/`BASIC_AUTH_PASSWORD`.

- **Own auth**: Services with built-in login (Gitea, Vaultwarden, Paperless-ngx, Stirling-PDF) do NOT need additional middleware.

**Rule of thumb:** If a service stores personal data or gives access to infrastructure, protect it. Public services (transit info, scheduling) must have NO auth middleware.

### 5. Dashboard Entry (`servers/home/configs/dash/index.html.template`)

- Add to appropriate section (Home/Cloud/Offsite)
- Use emoji icon and clear naming
- Pattern: subdomain, icon, name
- Add uptime badge from the monitoring server (e.g. `https://uptime-cloud.${DOMAIN}/api/v1/endpoints/home_SERVICENAME/health/badge.svg`)

### 6. Monitoring / Gatus

- Add endpoint to the **opposite server's** gatus config for cross-server monitoring:
  - Home service → add to `servers/cloud/configs/gatus.yml` (group: home)
  - Cloud service → add to `servers/home/configs/gatus.yml` (group: cloud)
- [ ] If the service has auth, add the appropriate `Authorization: Basic ${BASIC_AUTH_BASE64}` header
- [ ] Set appropriate conditions: usually `"[STATUS] == 200"`
- [ ] Add ntfy alert (copy from existing entries)

### 7. DNS Records (Cloudflare)

**Default routing**: `*.antonshubin.com` is a wildcard A record pointing to the
**home** server (`165.173.1.38`). All subdomains resolve to home by default.

**Cloud and offsite servers** need explicit A records for their subdomains:

- Cloud: `23.88.101.28`
- Offsite: `213.21.10.17`

**Proxied (orange cloud) recommendation:**

- Home records: proxied by default (wildcard `*.antonshubin.com` is proxied)
- Cloud records: `sync-cloud`, `uptime-cloud` are proxied; others are DNS-only
- **Offsite records: use `proxied: true`** — routes monitoring traffic through Cloudflare,
  bypassing Hetzner→home ISP routing issues (Russian govt internet interference).
  Cloudflare → origin may also fail during routing issues; a WireGuard tunnel
  offsite→cloud is the long-term fix.

When adding a service that runs on cloud or offsite, **always add a DNS record**.
When migrating a service from cloud/offsite to home, **delete its DNS record** so
the wildcard takes over.

#### Add a DNS record

```bash
CF_TOKEN=$(grep CLOUDFLARE_API_TOKEN .env.root | cut -d= -f2)
ZONE_ID=$(curl -s -X GET "https://api.cloudflare.com/client/v4/zones?name=antonshubin.com" \
  -H "Authorization: Bearer $CF_TOKEN" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['result'][0]['id'])")

curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"A","name":"SUBDOMAIN","content":"SERVER_IP","ttl":1,"proxied":false}'
```

#### Delete a DNS record (e.g. when moving a service to home)

```bash
# Find the record ID
RECORD_ID=$(curl -s "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records?name=SUBDOMAIN.antonshubin.com&type=A" \
  -H "Authorization: Bearer $CF_TOKEN" \
  | python3 -c "import sys,json; r=json.load(sys.stdin)['result']; print(r[0]['id'] if r else '')")

# Delete it
curl -s -X DELETE "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$RECORD_ID" \
  -H "Authorization: Bearer $CF_TOKEN"
```

**Token**: stored in `.env.root` as `CLOUDFLARE_API_TOKEN` (encrypted in `.env.root.age`). Read-only + DNS edit scope.

## 🚨 Error Handling Patterns

```typescript
// Use consistent error handling
export function getEnvVar(key: string, isOptional = false): string {
  const value = Deno.env.get(key)
  if (!value && !isOptional) {
    throw new Error(`Missing environment variable: ${key}`)
  }
  return value || ""
}

// Return structured results from commands
export async function runCommand(
  cmd: string[],
  options?: { sudo?: boolean; cwd?: string },
): Promise<{ success: boolean; output: string; error: string }> {
  // Implementation with error handling
}
```

## 🏗️ Infrastructure as Code Priority

**All configs must be defined in code before anything is deployed manually.** This repo must remain fully reproducible:

1. **Compose files** define what runs, how it's networked, and resource limits
2. **Gatus** monitors every service from the opposite server (cross-server monitoring)
3. **Dashboard** at `dash.${DOMAIN}` lists every service with health badges
4. **Backup configs** protect persistent data
5. **.env + .env.example** (encrypted) contain all secrets
6. **Traefik labels** control routing, TLS, and auth (basic auth middleware = `auth`)
7. **config.json** declares which stacks each server deploys

Before any manual container manipulation: check if the change can be codified in a compose.yml. If it cannot, document the manual step in a README.

## 📝 Key Principles

1. **Infrastructure as Code First**: Everything defined in code, no manual UI changes
2. **Stacks Catalog Pattern**: Services in `stacks/`, servers choose what to deploy
3. **Backups First**: Services with data MUST have backup configs
4. **Follow Patterns**: Check existing examples for similar services
5. **Keep It Simple**: Use defaults unless custom configuration is necessary
6. **No Default Docker Network**: Single-service stacks must alias `default` to `proxy` to avoid wasting Docker subnets. Only multi-service stacks (app ↔ db) get a real `default` network.
7. **Documentation**: Every stack needs README.md

## 🧪 Testing

- Uses Deno's built-in test runner
- Test files: `*.test.ts` pattern
- Currently limited test coverage - tests encouraged but not required
- Run tests with `deno task test`

## 🔄 CI/CD

- No automated CI/CD currently
- Manual checks via `deno task check`
- Focus on local development and manual deployment

## 📋 Quick Reference

| Task        | Command                             | Description                      |
| ----------- | ----------------------------------- | -------------------------------- |
| All checks  | `deno task check`                   | Run lint, fmt, type-check, tests |
| Fix all     | `deno task fix`                     | Auto-fix linting and formatting  |
| Deploy      | `deno task deploy <server>`         | Deploy all services              |
| Deploy one  | `deno task deploy <server> <stack>` | Deploy single stack              |
| Backup      | `deno task backup`                  | Run backup system                |
| SSH         | `deno task ssh <server> [cmd]`      | SSH into server / run remote cmd |
| Ansible     | `deno task ansible <playbook>`      | Run Ansible playbooks            |
| Test single | `deno test path/to/file.test.ts`    | Run specific test                |
