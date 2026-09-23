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
}
