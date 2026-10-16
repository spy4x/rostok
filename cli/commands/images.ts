// `rostok images` — look at and move the pinned image tags of a server.

import { Command } from "@cliffy/command"
import { stripControlChars } from "../deploy/exec.ts"
import { checkPins, listServers, type PinRow, updatePins } from "../images/outdated.ts"
import { createRegistryClient } from "../images/registry.ts"
import type { resolveStackFiles } from "../deploy/stack-files.ts"

/** Test injection point: the `fetch` every registry request goes through. */
/** Test injection points: the `fetch` for every request, and where shipped stack files are. */
export interface ImagesCommandOverrides {
  fetch?: typeof fetch
  resolveFiles?: typeof resolveStackFiles
}

function describe(row: PinRow): string {
  const current = stripControlChars(row.current ?? "")
  switch (row.state) {
    case "outdated":
      return `${current} → ${stripControlChars(row.newest ?? "")}`
    case "current":
      return `${current} (newest)`
    case "unknown":
      return `${current} (could not check: ${stripControlChars(row.detail ?? "")})`
    default:
      return row.current === undefined
        ? `(${stripControlChars(row.detail ?? "")})`
        : `${current} (not pinned)`
  }
}

/** One aligned line per row: variable, image, and where the pin stands. */
export function formatPinRows(rows: PinRow[]): string[] {
  const width = (pick: (r: PinRow) => string) => Math.max(...rows.map((r) => pick(r).length))
  const variableWidth = width((r) => r.variable)
  const imageWidth = width((r) => r.image)
  return rows.map((r) =>
    `  ${r.variable.padEnd(variableWidth)}  ${r.image.padEnd(imageWidth)}  ${describe(r)}`
  )
}

/** `rostok images outdated [server]`: print each tag variable next to the newest version. */
export async function runImagesOutdated(
  server: string | undefined,
  cwd: string = Deno.cwd(),
  overrides: ImagesCommandOverrides = {},
): Promise<PinRow[]> {
  const client = createRegistryClient({ fetch: overrides.fetch })
  const servers = server === undefined ? await listServers(cwd) : [server]
  if (servers.length === 0) console.log("No servers in this project yet.")
  const all: PinRow[] = []
  for (const name of servers) {
    const rows = await checkPins(cwd, name, client, undefined, overrides)
    all.push(...rows)
    console.log(name)
    if (rows.length === 0) console.log("  no images with a tag variable")
    for (const line of formatPinRows(rows)) console.log(line)
    const outdated = rows.filter((r) => r.state === "outdated").length
    if (outdated > 0) {
      console.log(`  ${outdated} outdated: run \`rostok images update ${name}\` to move them.`)
    }
  }
  return all
}

/** `rostok images update <server> [stack]`: rewrite the outdated pins; never deploys. */
export async function runImagesUpdate(
  server: string,
  stack: string | undefined,
  cwd: string = Deno.cwd(),
  overrides: ImagesCommandOverrides = {},
): Promise<PinRow[]> {
  const client = createRegistryClient({ fetch: overrides.fetch })
  const rows = await updatePins(cwd, server, client, stack, overrides)
  const moved = rows.filter((r) => r.state === "outdated")
  for (const row of rows.filter((r) => r.state === "unknown")) {
    console.warn(`rostok: could not check ${row.image} (${stripControlChars(row.detail ?? "")}).`)
  }
  if (moved.length === 0) {
    console.log(`Nothing to update on ${server}.`)
    return rows
  }
  for (const row of moved) {
    console.log(
      `${row.variable}: ${stripControlChars(row.current ?? "")} → ${
        stripControlChars(row.newest ?? "")
      }`,
    )
    if (row.link) console.log(`  ${row.link}`)
  }
  const pins = moved.length === 1 ? "1 pin" : `${moved.length} pins`
  console.log(
    `Updated ${pins} in servers/${server}/.env. Run \`rostok deploy ${server}\` to apply.`,
  )
  return rows
}

export const imagesCommand = new Command()
  .description(
    `Check and update pinned image versions.

Under IMAGE_POLICY=pinned, \`rostok stack add\` writes each image's
version into servers/<server>/.env. These commands show which of those
pins have a newer version and move them. Neither deploys.

Examples:

    rostok images outdated            # every server
    rostok images outdated home       # one server
    rostok images update home         # move every outdated pin on home
    rostok images update home gatus   # only the gatus stack`,
  )
  .command(
    "outdated",
    new Command()
      .arguments("[server:string]")
      .description("List each pinned image next to the newest version the registry has.")
      .action(async (_options, server?: string) => {
        await runImagesOutdated(server)
      }),
  )
  .command(
    "update",
    new Command()
      .arguments("<server:string> [stack:string]")
      .description("Rewrite outdated pins in the server's .env. Run `rostok deploy` afterwards.")
      .action(async (_options, server: string, stack?: string) => {
        await runImagesUpdate(server, stack)
      }),
  )
