# Adding a stack to the catalog

A **stack** is one self-hosted service the rostok CLI can scaffold onto
a user's server. Every stack in `stacks/<name>/` is generic — reusable
by any user, no hardcoded domains, IPs, or secrets.

This guide is for **contributors** adding a new stack. For users
already running `rostok`, see [`docs/usage/concepts.md`](../usage/concepts.md).

---

## File checklist

A new stack needs these files:

```
stacks/<name>/
├── compose.yml       # required
├── backup.ts         # required if stateful, skip if stateless
├── README.md         # required
└── +meta.ts          # required for rostok v1 — CLI schema
```

`+meta.ts` is the CLI's "what variables does this stack need?" file.
See [`docs/design/v1-cli.md`](../design/v1-cli.md) §4 for the full
schema. Until v1 ships, you can ship the stack without `+meta.ts`
(the CLI will prompt with generic questions instead).

---

## `compose.yml`

A minimal stack that joins the proxy network so Traefik can route to it:

```yaml
services:
  myservice:
    image: myservice/myservice:1.2.3          # pin a version, never :latest
    container_name: hl-myservice              # `hl-` prefix mandatory
    restart: unless-stopped
    networks: [proxy]
    volumes:
      - ${VOLUMES_PATH}/myservice:/data
    environment:
      - DOMAIN=${DOMAIN}                      # placeholder, never hardcoded
      - SOME_TOKEN=${SOME_TOKEN}              # CLI will prompt for this
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.hl-myservice.rule=Host(`myservice.${DOMAIN}`)"
      - "traefik.http.routers.hl-myservice.entrypoints=websecure"
      - "traefik.http.routers.hl-myservice.tls.certresolver=letsencrypt"
    # Auth middleware — every non-public service needs one:
    - "traefik.http.routers.hl-myservice.middlewares=authelia@file"
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 512M

networks:
  proxy:
    external: true
```

### Rules

- **Container name prefix `hl-`** — `hl-myservice`, not `myservice`.
  This avoids name conflicts with other projects on the same host.
  Same prefix on Traefik routers/services.
- **Pin image versions** — never `:latest`. Use `1.2.3` or
  `1.2-alpine`.
- **No hardcoded domains or IPs** — use `${DOMAIN}` placeholders;
  Traefik labels interpolate them.
- **No hardcoded secrets** — declare them in `+meta.ts` as `secret: true`
  variables; the CLI prompts the user.
- **Auth middleware** — every non-public service needs one:
  - `middlewares=authelia@file` if the user has SSO
  - `middlewares=auth` (basic auth) as a fallback
  - Public services (status pages, calendars) have no auth middleware
- **Resource limits** — set `cpus` and `memory` so a misbehaving
  container can't starve the host.
- **Single-service stack** — if the stack has only one container, alias
  `default` to `proxy` to avoid wasting a Docker subnet:
  ```yaml
  networks:
    proxy:
      external: true
    default:
      external: true
      name: proxy
  ```
- **Multi-service stack** (app + db) — declare a real `default` network
  for the stack; keep `proxy` for app's external routing.

See `stacks/traefik/compose.yml`, `stacks/vaultwarden/compose.yml`, and
`stacks/gatus/compose.yml` for reference.

---

## `backup.ts`

(Can be omitted for stateless services — pure proxies, transcoders
without persistent state, etc.)

```ts
import { BackupConfig } from "../../scripts/backup/src/+lib.ts"

const backupConfig: BackupConfig = {
  name: "myservice",
  sourcePaths: "default",          // uses ${VOLUMES_PATH}/myservice
  containers: {
    stop: "hl-myservice",          // container to stop+start during backup
  },
}

export default backupConfig
```

This is the per-stack file the `scripts/backup/` system reads. The
`BackupConfig` type lives in `scripts/backup/src/types.ts`.

Options:
- `sourcePaths: "default"` — auto-derived from `${VOLUMES_PATH}/<name>`
- `sourcePaths: "/custom/path"` — explicit path
- `containers.stop: "default"` — uses `hl-<name>` (same as container_name)
- `containers.stop: ["hl-app", "hl-db"]` — multi-container stacks
- `containers.stop: false` — no stop; live backup (e.g., DB that hot-
  backups itself)

User-level backup configs that span multiple stacks (e.g., a
home-directory mirror) live in the user's project folder, not in the
catalog. The catalog only ships per-stack configs under
`stacks/<name>/backup.ts`.

---

## `before.deploy.ts` / `after.deploy.ts` (optional)

Standalone Deno scripts `rostok deploy` runs with `deno run -A` — before
and after `docker compose up`, respectively. Optional; a stack without
either is a no-op for that hook. Self-contained: no import out of the
stack's own directory (a JSR install runs a hook from an `https://` URL,
where a relative parent import can't resolve — see `stacks/traefik/`
and `stacks/gatus/` for the pattern of inlining a small shared helper
instead of importing it).

**Environment.** A hook receives a filtered view of `.env`/`.env.root`:
only server-level keys (`DOMAIN`, `PROJECT`, ...) and keys carrying the
stack's own prefix (`stackKeyPrefix()` — `TRAEFIK_*` for the traefik
stack) reach it; everything else is dropped. Plus the contract keys
`SSH_ADDRESS`, `SSH_USER`, `PATH_APPS` and `DEPLOY_AS`. `-A` means a
hook is fully trusted code — read/write/net/run/env, no sandbox — the
same trust a `+meta.ts` or `backup.ts` already gets; it is not
sandboxed against the `.env`/`.env.root` content it's handed.

**Termination.** `rostok deploy` signals a hook (SIGTERM, then SIGKILL
if it doesn't exit) on Ctrl-C, `kill`, Ctrl-\\ or a closed terminal. When the Deno build and OS
support it, the hook runs as its own process group and the WHOLE group
gets signalled — a child process the hook itself spawned (a
long-running build, a database migration) is reached automatically.
When that isn't available, only the hook's own process is signalled —
**a hook that spawns a child process of its own must forward SIGTERM
to it** (and exit once that child does), or that child is orphaned on
an interrupted deploy. A hook that only runs short-lived commands and
waits for them to finish (the common case — `docker`, `curl`, a
one-shot script) needs no special handling; this only matters for a
hook that starts something long-running and returns before it's done.

**No terminal.** A hook in its own process group has no controlling
terminal, so it can't prompt. An `ssh` call in a hook that would ask for
a host key or a passphrase fails instead of asking: pass
`-o BatchMode=yes` so it fails fast with a clear error. The deploy has
already connected to the server once before any hook runs, so the host
key is normally known by then.

---

## `README.md`

A short doc with:

- **What it does** — one paragraph
- **Configuration** — list of variables (with `+meta.ts` keys)
- **Setup** — any post-deploy steps (e.g., "create admin user")
- **Troubleshooting** — common errors

Two paragraphs minimum. Don't paste the full Traefik label block.

---

## `+meta.ts` (rostok v1 schema)

Declares what variables the CLI needs to prompt for. Generic, no
real values.

```ts
import type { StackMeta } from "@rostok/cli"
import { generatePassword } from "@rostok/cli"

export default {
  name: "myservice",
  description: "What this service does in one sentence",
  category: "data",                          // for `rostok stack list` grouping
  variables: [
    {
      key: "IMAGE_TAG",
      default: "1.2.3",
      required: false,
    },
    {
      key: "MYSERVICE_ADMIN_USER",
      question: "Admin username?",
      default: "admin",
      required: true,
    },
    {
      key: "MYSERVICE_ADMIN_PASSWORD",
      question: "Admin password?",
      default: () => generatePassword(24),
      required: true,
      secret: true,
    },
  ],
} satisfies StackMeta
```

### Rules

- **Every `required: true` variable has a `default`** — non-interactive
  mode fails loud if missing.
- **Secrets are `secret: true`** — never echoed, never logged,
  encrypted via age64.
- **`default: () => generatePassword(N)`** for secrets — uses
  `crypto.getRandomValues`, not `Math.random`.
- **`IMAGE_TAG` is a regular variable** — not a separate `defaults`
  block. Always `required: false`.
- **`${SERVER_NAME}` is the only allowed placeholder** — server-level
  vars resolved before stack vars; v1 only supports this one.

---

## Verify before opening a PR

```bash
deno task check                  # lint + fmt + type-check + tests
deno task ts:check                   # type-check stacks/<name>/*.ts
deno task fmt:check                  # format
```

CI (when present) runs the same checks. A failing check blocks merge.

For visual review, run `deno task env:decrypt` and inspect the
generated `.env` shape (don't commit it — it's gitignored).

---

## Open the PR

- Branch: `feat/<stack>-stack` or `feat/add-<stack>`
- Title: `feat(stacks): add <stack>`
- PR body: link the issue, list files added, paste the relevant
  checklist items above
- Reference: `Closes #N` if there is an issue, or just describe the
  motivation

The reviewer will check:
- `hl-` prefix on container + Traefik
- No hardcoded secrets, domains, IPs
- `+meta.ts` defaults are sensible
- `backup.ts` present if stateful
- README is useful
- `deno task check` passes
