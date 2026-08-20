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
