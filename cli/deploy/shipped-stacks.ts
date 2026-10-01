// Checked-in manifest of the deploy-relevant files each bundled catalog
// stack ships inside the published CLI package (jsr:@rostok/cli).
//
// A JSR install can't list a directory (https:// URLs aren't
// browsable), so `stack-files.ts` can't discover these files at
// runtime the way it does for a local `<project>/stacks/<name>/`
// override. This manifest is the source of truth instead.
//
// Kept in sync with disk by shipped-stacks.test.ts: any file added under
// a listed stack's directory (other than `+meta.ts`, `backup.ts`,
// `README.md` and `*.test.ts`) fails that test until this manifest is
// updated. The same test also fails if a stack is added to
// `cli/catalog.ts` without a matching entry here.
//
// Adding a stack to the catalog: add its `+meta.ts` import to
// cli/catalog.ts AND its deploy files here AND re-include them in
// deno.jsonc's `publish.exclude` (see the comment there).

/** Catalog stack name → deploy-relevant files, relative to `stacks/<name>/`. */
export const SHIPPED_STACK_FILES: Record<string, readonly string[]> = {
  traefik: [
    "compose.yml",
    "before.deploy.ts",
    "after.deploy.ts",
    "dynamic/00-base.yml",
  ],
  gatus: [
    "compose.yml",
    "config.yml",
    "before.deploy.ts",
    "after.deploy.ts",
  ],
  vaultwarden: [
    "compose.yml",
  ],
  jellyfin: [
    "compose.yml",
  ],
  filebrowser: [
    "compose.yml",
  ],
  librespeed: [
    "compose.yml",
  ],
  "deepseek-harness": [
    "systemd/dsh.service",
  ],
  watchtower: [
    "compose.yml",
  ],
  syncthing: [
    "compose.yml",
    "before.deploy.ts",
    "after.deploy.ts",
  ],
  "home-assistant": [
    "compose.yml",
    "compose.traefik.yml",
  ],
  wireguard: [
    "compose.yml",
  ],
  ntfy: [
    "compose.yml",
  ],
  oko: [
    "compose.yml",
  ],
  immich: [
    "compose.yml",
    "hwaccel.ml.yml",
    "hwaccel.transcoding.yml",
  ],
  piped: [
    "before.deploy.ts",
    "compose.yml",
    "config.properties.template",
    "substitute-env.ts",
  ],
  transmission: [
    "compose.yml",
  ],
  playwright: [
    "Dockerfile.mcp-proxy",
    "compose.yml",
  ],
  searxng: [
    "before.deploy.ts",
    "compose.yml",
    "limiter.toml",
    "searxng-settings.yml",
  ],
  "open-webui": [
    "after.deploy.ts",
    "compose.yml",
    "hook-lib.ts",
    "init-models.py",
    "mcpo-config.json",
  ],
  audiobookshelf: [
    "compose.yml",
  ],
  metube: [
    "compose.yml",
  ],
  woodpecker: [
    "compose.yml",
  ],
  usememos: [
    "compose.yml",
  ],
  "victoria-metrics": [
    "compose.yml",
  ],
  akaunting: [
    "compose.yml",
    "health.html",
  ],
  gitea: [
    "compose.yml",
    "public/robots.txt",
  ],
  traggo: [
    "compose.yml",
  ],
  "docker-registry": [
    "compose.yml",
  ],
  "docker-sock-proxy": [
    "compose.yml",
  ],
  "caldav-mcp": [
    "Dockerfile",
    "compose.yml",
  ],
  "email-mcp": [
    "before.deploy.ts",
    "compose.yml",
  ],
  "google-maps-mcp": [
    "Dockerfile",
    "compose.yml",
  ],
  "github-mcp": [
    "Dockerfile",
    "compose.yml",
    "http-wrapper.mjs",
  ],
  zond: [
    "before.deploy.ts",
    "compose.yml",
    "config.yml",
  ],
  "omni-tools": [
    "compose.yml",
  ],
  adguard: [
    "compose.yml",
  ],
  cloudflared: [
    "compose.yml",
  ],
  healthchecks: [
    "compose.yml",
    "entrypoint.sh",
  ],
  nginx: [
    "compose.yml",
  ],
  ollama: [
    "compose.yml",
  ],
  umami: [
    "compose.yml",
  ],
  mirotalk: [
    "cert-extract.py",
    "compose.yml",
  ],
  bulwark: [
    "compose.yml",
  ],
  caldiy: [
    "after.deploy.ts",
    "compose.yml",
  ],
  mig: [
    "compose.yml",
  ],
  stalwart: [
    "after.deploy.ts",
    "before.deploy.ts",
    "cert-sync.py",
    "compose.yml",
    "config.json",
    "dkim.ts",
    "mta-sts/html/.well-known/mta-sts.txt.template",
    "mta-sts/nginx.conf",
  ],
  pangolin: [
    "before.deploy.ts",
    "compose.yml",
    "traefik/dynamic/00-pangolin.yml",
    "traefik/traefik_config.yml",
  ],
}
