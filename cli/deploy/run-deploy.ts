// The deploy logic `rostok deploy <server> [stack]` runs in-process
// (#203 point 1). Ported from the old scripts/deploy/+main.ts, which now
// wraps this module (see scripts/deploy/+main.ts) so `deno task deploy`
// keeps working in this repo.
//
// Differences from the old script, per #203/#206/#207/#208:
//   - Takes the project directory, server name and optional stack as
//     arguments instead of reading `./` and `Deno.args`.
//   - Throws UserError on expected failures instead of calling Deno.exit.
//   - Validates the server name with `serverDirFor` before reading
//     anything (#208).
//   - Resolves each stack's files from the project's own `stacks/<name>/`
//     if present, otherwise from the files shipped inside the CLI
//     package (#203 point 2 — see stack-files.ts).
//   - Runs a docker-group preflight before any file is synced (#207), and
//     decides whether privileged remote commands need `sudo -n` from the
//     remote's own `id -u` — not from the SSH_USER string, which can be
//     stale or overridden by the SSH target/ssh_config.
//   - Applies the SSH_USER/PATH_APPS/PUID/PGID legacy fallbacks against
//     `.env.root` merged with the server `.env` (compose reads both) and
//     fails loudly on any still-missing DEPLOY_REQUIRED_KEYS (#206).
//   - Stops rsyncing `./scripts` and `./deno.jsonc` — only `.env`,
//     `.env.root`, `configs/`, `compose-override/` and the deployed
//     stacks' files are sent.
//   - Every value from `.env`/`config.json` embedded in a remote command
//     is single-quoted (`shQuote`); the old double-quoting still let
//     `$(...)`/backticks run inside it.
//   - SSH_ADDRESS, PATH_APPS and VOLUMES_PATH are validated (env.ts, via
//     cli/server-keys.ts's validateSshAddress/validateRemotePath) before
//     any of them reaches ssh/rsync argv or a remote command — an
//     SSH_ADDRESS starting with `-` (`-oProxyCommand=<cmd>`) would
//     otherwise run `<cmd>` locally the moment ssh (or rsync, which
//     re-spawns ssh with the same target) parsed it as an option. Every
//     direct ssh spawn in cli/deploy/ (exec.ts) also puts `--` before
//     the target as a second, independent guard — rsync's own re-spawn
//     of ssh can't take the same `--` (it splits a user@host address
//     into `-l user host` before invoking its `-e` command, and `--`
//     ahead of that makes ssh misread `-l` as the hostname instead), so
//     validateSshAddress is the only guard for that specific spawn; a
//     leading `--` before rsync's own positional args still guards
//     rsync's own argument parser.
//   - The staged `.env`/`.env.root` are chmod 0600 — both carry secrets,
//     and rsync -a would otherwise ship whatever mode the source file
//     happened to have to a directory other users on the remote can read.
//   - (#233) Deploy is now the server's source of truth. A full deploy
//     syncs PATH_APPS with `rsync --delete` (split into a root sync and
//     one scoped `--delete` per deployed stack — see the "Syncing
//     files" section below), so a file removed from the project
//     disappears from the server on the next deploy, and a file that's
//     newer on the server is still overwritten (`-u` dropped). A stack
//     `config.json` no longer lists gets `docker compose down
//     --remove-orphans` and its folder removed BEFORE any rsync runs
//     (stale-stacks.ts) — never its VOLUMES_PATH/<stack> data.
//     VOLUMES_PATH is validated to sit outside PATH_APPS (env.ts,
//     server-keys.ts's pathsNestedOrEqual) so `--delete` can never reach
//     app data.
//
// A stack's before/after hook is fully trusted code, run with `deno run
// -A` — see hooks.ts for what that does and doesn't protect against
// (it denies `.env`/`.env.root` from overriding PATH/HOME/DENO_*/etc.
// in the hook's own process env, but does not sandbox the hook itself).
//
// Kept from the old script: a server can override a stack's before-hook
// with `servers/<server>/configs/<deployAs>/before.deploy.ts`, run after
// the stack's own before-hook, FROM ITS STAGING COPY
// (`<staging>/configs/<deployAs>/before.deploy.ts`) — unlike a stack's
// own hook, this one is meant to run from a copy. The owner's real
// server-specific hooks reference sibling stack files by relative URL
// (`new URL("../../stacks/<name>/dynamic/", import.meta.url)`), which
// only resolves correctly once the hook sits inside the staging layout
// next to `stacks/`; running it from its original
// `servers/<server>/configs/<deployAs>/` location (which has no
// `stacks/` two levels up) would break that. The hook contract's "run
// from source, never a copy" rule is about STACK hooks, which are
// shipped and must not depend on staging's shape — a server-specific
// hook is never shipped, so it has no such constraint.

import { dirname, join, toFileUrl } from "@std/path"
import { parseEnv, readEnvFile } from "../env-files.ts"
import { serverDirFor } from "../server-keys.ts"
import { UserError } from "../errors.ts"
import { resolveDeployEnv } from "./env.ts"
import { checkDockerGroup, checkRemotePathsNotNested, needsRemoteSudo } from "./docker-preflight.ts"
import { type ResolvedStackFiles, resolveStackFiles } from "./stack-files.ts"
import { validateStackConfigs } from "./validate-stack-config.ts"
import { type HookContext, runHook } from "./hooks.ts"
import { extractVolumePaths, generateVolumeCreationScript } from "./volumes.ts"
import {
  type DeployResult,
  generateDeployScript,
  getRemoteChecksums,
  parseDeployResults,
  printDeploySummary,
  type StackConfig,
} from "./deploy-script.ts"
import { runRemoteShell, runRemoteSync, runRemoteSyncEntry, shQuote } from "./exec.ts"
import { killActiveChildren } from "./process-registry.ts"
import { generateStaleStackCleanupScript } from "./stale-stacks.ts"

export interface DeployOptions {
  /** Project root (the directory that holds `servers/` and `.env.root`). */
  cwd: string
  server: string
  /** Deploy only this stack instead of every stack in config.json. */
  stack?: string
}

export interface DeployRunResult {
  deployedStacks: string[]
  results: DeployResult[]
}

export async function runDeploy(opts: DeployOptions): Promise<DeployRunResult> {
  const { cwd, server } = opts

  // #208: validate the server name before reading anything.
  const serverDir = serverDirFor(cwd, server)
  const envPath = join(serverDir, ".env")
  if (!(await pathExists(envPath))) {
    throw new UserError(
      `server '${server}' not found at ${envPath}. Run \`rostok server create ${server}\` first.`,
    )
  }

  const env = entriesToRecord(await readEnvFile(envPath))

  const rootEnvPath = join(cwd, ".env.root")
  let rootEnvText = ""
  try {
    rootEnvText = await Deno.readTextFile(rootEnvPath)
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err
  }
  const rootEnv = entriesToRecord(parseEnv(rootEnvText))

  // #206: legacy fallbacks (SSH_USER, PATH_APPS, PUID, PGID), then fail
  // loudly on any still-missing DEPLOY_REQUIRED_KEYS. Checked against
  // .env.root merged with the server .env (server wins) — compose itself
  // reads both, so a key genuinely declared only in .env.root must count.
  const { env: resolvedEnv, notices } = resolveDeployEnv(
    { ...rootEnv, ...env },
    envPath,
    rootEnvPath,
  )
  for (const notice of notices) console.error(notice)

  const SSH_ADDRESS = resolvedEnv.SSH_ADDRESS
  const SSH_USER = resolvedEnv.SSH_USER
  const PATH_APPS = resolvedEnv.PATH_APPS
  const VOLUMES_PATH = resolvedEnv.VOLUMES_PATH
  const PUID = resolvedEnv.PUID
  const PGID = resolvedEnv.PGID
  const DOCKER_GROUP_ID = resolvedEnv.DOCKER_GROUP_ID

  // #207: preflight before any file is synced. Docker group GID, and
  // whether privileged commands need `sudo -n` — decided from the
  // remote's own `id -u`, not from the SSH_USER string (see
  // docker-preflight.ts's needsRemoteSudo for why). The mismatch message
  // names whichever file DOCKER_GROUP_ID actually came from — it's a
  // DEPLOY_REQUIRED_KEYS key, so the merged-env check guarantees it's in
  // one of the two, but not necessarily the server .env (env wins the
  // merge only when it HAS the key).
  const dockerGroupIdSource = env.DOCKER_GROUP_ID ? envPath : rootEnvPath
  await checkDockerGroup(SSH_ADDRESS, DOCKER_GROUP_ID, dockerGroupIdSource)
  const needsSudo = await needsRemoteSudo(SSH_ADDRESS)
  // #233 review: a symlink ON THE SERVER ITSELF (VOLUMES_PATH pointing
  // inside PATH_APPS, or the reverse) can defeat env.ts's own
  // pathsNestedOrEqual check, which only ever sees the `.env` strings —
  // asking the real server with `readlink -f` is the only way to catch
  // that. Refuses (nothing deleted) before any deletion below.
  await checkRemotePathsNotNested(SSH_ADDRESS, PATH_APPS, VOLUMES_PATH)

  // config.json → which stacks to deploy. Missing entirely (never run
  // `rostok server create`/no stacks added yet — distinct from an
  // explicit `"stacks": []`, which IS the project's real truth and does
  // trigger cleanup below) must never be read as "delete every stack
  // and every file already on the server" (#233 review) — decision:
  // skip the destructive steps (stale-stack cleanup, the root sync's
  // --delete) entirely and say so, rather than refuse the whole deploy;
  // there's nothing useful to deploy either way (`stacks` ends up
  // empty), and a typo'd server dir or a config.json genuinely not
  // written yet shouldn't be treated as "wipe the server".
  const configPath = join(serverDir, "config.json")
  let config: { stacks?: StackConfig[] } = {}
  let configFileFound = true
  try {
    config = JSON.parse(await Deno.readTextFile(configPath))
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      configFileFound = false
      console.error(
        `Notice: ${configPath} not found — skipping stale-stack cleanup and the deletion side ` +
          `of the file sync. Nothing to deploy either way; run \`rostok stack add\` first.`,
      )
    } else {
      throw err
    }
  }
  // Every stack's name/deployAs, validated before anything is built (a
  // newline in either could otherwise break out of a `#` comment line in
  // the generated deploy script — see validate-stack-config.ts).
  validateStackConfigs(config.stacks ?? [], configPath)

  // The FULL list, never filtered down by opts.stack below — used for
  // the hook allow-list's #234 silencing (a key belonging to another
  // INSTALLED stack shouldn't warn) and for #233's stale-stack/rsync
  // scoping (a single-stack deploy must still know every OTHER stack
  // that's supposed to keep existing on the server).
  const allStackNames = (config.stacks ?? []).map((s) => s.name)

  let stacks = config.stacks ?? []
  if (opts.stack !== undefined) {
    const filtered = stacks.filter((s) => s.name === opts.stack)
    if (filtered.length === 0) {
      throw new UserError(
        `stack '${opts.stack}' not found in server '${server}' config.json. ` +
          `Available: ${stacks.map((s) => s.name).join(", ") || "(none)"}`,
      )
    }
    stacks = filtered
  }

  // #219 (and a later review round): the staging dir holds a plaintext
  // copy of `.env`/`.env.root` (secrets) — a Ctrl-C or `kill` mid-deploy
  // skips the `finally` below entirely, leaving those on disk until the
  // next reboot clears /tmp.
  //
  // The handler below is FULLY SYNCHRONOUS end to end — no `await`
  // anywhere in it or in anything it calls (killActiveChildren,
  // Deno.removeSync). An async handler yields the event loop between
  // its own steps, which lets the main flow below keep running
  // concurrently — observed for real: staging a ~1,500-file stack, a
  // signal survived 3 times out of 5 with an async
  // `killActiveChildren(); await Deno.remove(...)` handler, because the
  // main loop's own `await fetchToFile(...)` calls kept creating new
  // files in the same directory while the async removal was walking it.
  // A synchronous function runs to completion without yielding, so
  // nothing else can interleave with it — closing that window. SIGHUP
  // (a closed terminal or dropped ssh session) and SIGQUIT (Ctrl-\\)
  // would otherwise take their default action and leave the same files.
  const stagingDir = await Deno.makeTempDir({ prefix: "rostok-deploy-" })
  const removeSignalCleanup = installStagingSignalCleanup(stagingDir)
  try {
    // Whitelisted files only — no ./scripts, no ./deno.jsonc (#203 point 3).
    // Both carry secrets, so chmod to 0600 regardless of the source
    // file's mode or the process umask — rsync -a preserves this on the
    // remote, where these land in PATH_APPS, potentially readable by
    // every user on a shared box otherwise.
    const stagedEnvPath = join(stagingDir, ".env")
    await Deno.copyFile(envPath, stagedEnvPath)
    await Deno.chmod(stagedEnvPath, 0o600)
    // Compose reads .env.root with --env-file; create an empty one in
    // staging when the project has none.
    const stagedRootEnvPath = join(stagingDir, ".env.root")
    await Deno.writeTextFile(stagedRootEnvPath, rootEnvText)
    await Deno.chmod(stagedRootEnvPath, 0o600)
    await copyIfExists(join(serverDir, "configs"), join(stagingDir, "configs"))
    await copyIfExists(join(serverDir, "compose-override"), join(stagingDir, "compose-override"))

    // Stage each active stack's files, resolved from the project's own
    // stacks/<name>/ or from the shipped catalog (#203 point 2).
    const stackFiles = new Map<string, ResolvedStackFiles>()
    for (const stackConfig of stacks) {
      const resolved = await resolveStackFiles(cwd, stackConfig.name)
      stackFiles.set(stackConfig.name, resolved)
      for (const [rel, url] of resolved.files) {
        await fetchToFile(url, join(stagingDir, "stacks", stackConfig.name, rel))
      }
      console.log(
        ` + stacks/${stackConfig.name} (${resolved.origin}, ${resolved.files.size} file(s))`,
      )
    }

    // config.json's per-stack `envs` (`${VAR}` filled from .env.root
    // merged with the server .env — a referenced key can legitimately
    // live in either file) — written into the staging .env once, if not
    // already there.
    for (const stackConfig of stacks) {
      await applyStackEnvs(stackConfig, resolvedEnv, stagingDir)
    }

    // Before-hooks — from source, cwd = staging (see hooks.ts).
    for (const stackConfig of stacks) {
      const deployAs = stackConfig.deployAs || stackConfig.name
      const ctx: HookContext = {
        rootEnv,
        serverEnv: env,
        envPath,
        rootEnvPath,
        sshAddress: SSH_ADDRESS,
        sshUser: SSH_USER,
        pathApps: PATH_APPS,
        deployAs,
        installedStackNames: allStackNames,
      }
      await runHook(
        "before",
        stackConfig.name,
        stackFiles.get(stackConfig.name)?.files.get("before.deploy.ts"),
        stagingDir,
        ctx,
      )

      // Server-specific override hook, run after the stack's own
      // before-hook, from its STAGING COPY:
      // <staging>/configs/<deployAs>/before.deploy.ts (copied from
      // servers/<server>/configs/<deployAs>/ above, alongside
      // copyIfExists(.../configs, ...)). It has to run from there, not
      // its original project location — a real one uses
      // `new URL("../../stacks/<name>/dynamic/", import.meta.url)` to
      // reach its stack's files, which only resolves correctly inside
      // staging's flat `configs/<x>/` + `stacks/<name>/` layout.
      const stagedServerHookPath = join(stagingDir, "configs", deployAs, "before.deploy.ts")
      if (await pathExists(stagedServerHookPath)) {
        // The real stack name goes in as `stackName` (buildHookEnv uses
        // it to compute the allowlist prefix — TRAEFIK_*, GATUS_*, ...);
        // the descriptive label is separate, so the override doesn't
        // lose access to its own stack's keys just because it's labeled
        // differently in logs.
        await runHook(
          "before",
          stackConfig.name,
          toFileUrl(stagedServerHookPath).href,
          stagingDir,
          ctx,
          `${stackConfig.name} (server override)`,
        )
      }
    }

    // Snapshot checksums of watched config files before rsync.
    const stacksWithConfigFiles = stacks.filter(
      (s) => s.watchFilesAndRestartIfChanged && s.watchFilesAndRestartIfChanged.length > 0,
    )
    const checksumsBefore = new Map<string, Map<string, string>>()
    for (const stackConfig of stacksWithConfigFiles) {
      const deployAs = stackConfig.deployAs || stackConfig.name
      checksumsBefore.set(
        deployAs,
        await getRemoteChecksums(
          SSH_ADDRESS,
          PATH_APPS,
          stackConfig.watchFilesAndRestartIfChanged!,
        ),
      )
    }

    // Every remote path this deploy will ever write or delete under
    // needs PATH_APPS/stacks to exist first — a fresh server has
    // neither PATH_APPS nor its stacks/ subdirectory yet, and rsync
    // itself refuses to create a deeply nonexistent destination without
    // `--mkpath` (confirmed directly: `rsync ... into fresh/srv/apps/`
    // on a fresh tree fails "mkdir ... No such file or directory").
    // `mkdir -p` covers both PATH_APPS and PATH_APPS/stacks in one call,
    // and is a no-op on an existing tree.
    const mkdirResult = await runRemoteShell(
      SSH_ADDRESS,
      `mkdir -p -- ${shQuote(`${PATH_APPS}/stacks`)}`,
    )
    if (!mkdirResult.success) {
      throw new UserError(
        `could not create ${PATH_APPS}/stacks on ${SSH_ADDRESS}: ${mkdirResult.error.trim()}`,
      )
    }

    // #233 point 4, and point 3 decision A: stop and remove every stack
    // config.json no longer lists, BEFORE any rsync --delete runs below
    // — once rsync deletes a stale stack's folder, there's nothing left
    // to find its containers by folder. Runs ONLY on a full deploy
    // (opts.stack undefined): a single-stack deploy (`rostok deploy
    // <server> <stack>`) must touch only that one stack's own
    // stacks/<name>/ — stopping or removing any OTHER stack is exactly
    // the cross-stack reach #233's single-stack scoping promises never
    // happens. Uses allStackNames (the FULL config.stacks list) when it
    // does run, never the filtered `stacks`. Skipped entirely (with a
    // notice already printed above) when config.json itself is missing
    // — never "no config.json" == "delete everything" (#233 review).
    // VOLUMES_PATH/<stack> is never referenced by a command in the
    // generated script (see stale-stacks.ts) — only named in its own
    // printed message — so app data always survives a stack's removal.
    // A failure here is a hard UserError, not a warning: the script
    // itself now correctly reports which stop/removal failed, and
    // silently continuing past a stack that's still running, unmanaged,
    // would hide that from the operator.
    if (opts.stack === undefined && configFileFound) {
      const staleCleanupScript = generateStaleStackCleanupScript(
        allStackNames,
        PATH_APPS,
        VOLUMES_PATH,
      )
      const staleCleanupResult = await runRemoteShell(SSH_ADDRESS, staleCleanupScript)
      if (staleCleanupResult.output.trim()) console.log(staleCleanupResult.output.trim())
      if (!staleCleanupResult.success) {
        throw new UserError(
          `failed to clean up stale stacks on ${SSH_ADDRESS}: ` +
            `${staleCleanupResult.error.trim() || staleCleanupResult.output.trim()}`,
        )
      }
    }

    console.log(`Syncing files to ${SSH_ADDRESS}:${PATH_APPS}...`)
    // rsync re-spawns ssh with SSH_ADDRESS as its destination, so this is
    // the other place a malicious address could reach ssh's option
    // parser — but `-e "ssh --"` (the same guard as exec.ts's
    // runRemoteCommand/runRemoteShell) does NOT work here: for a
    // user@host address, rsync itself splits it into `-l user host`
    // before invoking the -e command, so `ssh -- -l user host` reads
    // `-l` (now past the `--`) as the hostname and fails with "hostname
    // contains invalid characters" — confirmed against a real server.
    // `validateSshAddress` (env.ts, called before this point) is the
    // real guard here: it rejects a leading `-` outright. `runRemoteSync`
    // (exec.ts) still puts `--` before its own positional args, guarding
    // rsync's own argument parser from a `-`-led destination — a second,
    // independent layer, not the only one.
    //
    // #233 points 2/3: two separate rsync calls, never one. The root
    // sync below carries everything staged EXCEPT stacks/ (`--exclude=
    // /stacks`, anchored to the root — an unanchored `--exclude=stacks`
    // would also match a nested dir/file merely NAMED "stacks" anywhere
    // else in the tree, e.g. a hypothetical configs/foo/stacks/) — .env,
    // .env.root, configs/, compose-override/ — and only deletes stale
    // files on a FULL deploy with config.json present (never "no
    // config.json" == "delete everything", #233 review); a single-stack
    // deploy must never delete another stack's server-level config files
    // it isn't touching either. Every deployed stack then gets its OWN
    // sync, via `runRemoteSyncEntry` (exec.ts) — no trailing slash on the
    // LOCAL source, so rsync transfers it as one named entry into
    // `PATH_APPS/stacks/`, always with --delete: that scoping — not a
    // filter rule that could be misconfigured — is what makes it
    // impossible for a single-stack deploy to delete anything outside
    // that one stack's own folder, AND (review round) what makes rsync
    // REPLACE a symlinked `stacks/<name>` with a real directory instead
    // of following it into whatever it points at — `runRemoteSync`'s own
    // trailing-slash-on-both shape does the opposite (confirmed directly
    // against a real rsync: it deletes/overwrites INSIDE the symlink's
    // target). Both proven in exec.test.ts/run-deploy.test.ts. `-u` is
    // dropped from both: the project's copy must always win, even over a
    // file that's newer on the server (deploy is the source of truth,
    // #233).
    const rootSyncArgs = ["-avhz", "--exclude=/stacks"]
    if (opts.stack === undefined && configFileFound) {
      rootSyncArgs.push("--delete")
    }
    const rsyncResult = await runRemoteSync(SSH_ADDRESS, stagingDir, PATH_APPS, rootSyncArgs)
    if (!rsyncResult.success) {
      throw new UserError(
        `rsync of ${server} to ${SSH_ADDRESS} failed: ${rsyncResult.error.trim()}`,
      )
    }

    for (const stackConfig of stacks) {
      const stackStagingDir = join(stagingDir, "stacks", stackConfig.name)
      if (!(await pathExists(stackStagingDir))) {
        // A host-level stack (no compose.yml/files of its own, e.g. one
        // driven entirely by a hook) has nothing to sync — and nothing
        // on the remote to delete either, since it was never given a
        // stacks/<name>/ folder in the first place.
        continue
      }
      const stackSyncResult = await runRemoteSyncEntry(
        SSH_ADDRESS,
        stackStagingDir,
        `${PATH_APPS}/stacks`,
        ["-avhz", "--delete"],
      )
      if (!stackSyncResult.success) {
        throw new UserError(
          `rsync of stack '${stackConfig.name}' to ${SSH_ADDRESS}:${PATH_APPS}/stacks failed: ` +
            `${stackSyncResult.error.trim()}`,
        )
      }
    }

    // Snapshot checksums after rsync and detect changes.
    const restartStacks = new Set<string>()
    for (const stackConfig of stacksWithConfigFiles) {
      const deployAs = stackConfig.deployAs || stackConfig.name
      const after = await getRemoteChecksums(
        SSH_ADDRESS,
        PATH_APPS,
        stackConfig.watchFilesAndRestartIfChanged!,
      )
      const before = checksumsBefore.get(deployAs)
      if (before) {
        // The UNION of both snapshots' paths (review round) — iterating
        // only `after`'s own keys, as this used to, never visits a
        // watched file that was REMOVED entirely: getRemoteChecksums
        // skips a missing file's checksum rather than recording an
        // empty one, so a deleted file simply has no key in `after` at
        // all, and its removal never triggered a restart. `before.get`/
        // `after.get` both correctly return `undefined` for their own
        // missing side, so a plain `!==` still tells "added",
        // "removed" and "changed" apart from "unchanged" (`undefined
        // !== undefined` is `false`).
        const allWatchedPaths = new Set([...before.keys(), ...after.keys()])
        for (const filePath of allWatchedPaths) {
          if (before.get(filePath) !== after.get(filePath)) restartStacks.add(deployAs)
        }
      }
    }

    console.log("Ensuring proxy network exists on remote server...")
    const networkResult = await runRemoteShell(
      SSH_ADDRESS,
      `docker network inspect proxy >/dev/null 2>&1 || docker network create proxy`,
    )
    if (!networkResult.success) {
      throw new UserError(
        `failed to ensure the proxy network on ${SSH_ADDRESS}: ${networkResult.error.trim()}`,
      )
    }

    let results: DeployResult[] = []
    if (stacks.length > 0) {
      const composeContents: string[] = []
      for (const stackConfig of stacks) {
        const composePath = join(stagingDir, "stacks", stackConfig.name, "compose.yml")
        try {
          composeContents.push(await Deno.readTextFile(composePath))
        } catch {
          // No compose.yml (e.g. a host-level stack like deepseek-harness) — skip.
        }
      }
      // Merged env: a compose file's ${VOLUMES_PATH} (or any other var
      // referenced inside a volume path) can live in .env.root alone —
      // using the server .env in isolation here silently extracted the
      // literal, unexpanded "${VOLUMES_PATH}/..." string and deploy
      // reported success while creating nothing real on the remote.
      const volumePaths = extractVolumePaths(composeContents, resolvedEnv)
      if (volumePaths.length > 0 && VOLUMES_PATH) {
        console.log(`Creating ${volumePaths.length} volume directories with correct ownership...`)
        const script = generateVolumeCreationScript(volumePaths, PUID, PGID, needsSudo)
        const volumesResult = await runRemoteShell(SSH_ADDRESS, script)
        if (!volumesResult.success) {
          const sudoHint = needsSudo
            ? ` The remote user on ${SSH_ADDRESS} isn't root — mkdir/chown need passwordless ` +
              `sudo (a NOPASSWD rule in /etc/sudoers for that user).`
            : ""
          throw new UserError(
            `failed to create/chown volume directories on ${SSH_ADDRESS}: ` +
              `${volumesResult.error.trim()}.${sudoHint}`,
          )
        }
        console.log("Volume directories created")
      }

      const deployScript = generateDeployScript(stacks, PATH_APPS, restartStacks)
      const deployResult = await runRemoteShell(SSH_ADDRESS, deployScript)
      results = parseDeployResults(deployResult.output, stacks)
      printDeploySummary(results)

      const failed = results.filter((r) => !r.success)
      if (failed.length > 0) {
        throw new UserError(
          `${failed.length} stack(s) failed to deploy: ${failed.map((r) => r.name).join(", ")}`,
        )
      }
    } else {
      console.log("No stacks to deploy")
    }

    // After-hooks run after `docker compose up`. Every stack's hook runs
    // even if an earlier one fails, so one broken hook doesn't hide
    // problems in the others; all failures are reported together.
    const afterFailures: string[] = []
    for (const stackConfig of stacks) {
      const deployAs = stackConfig.deployAs || stackConfig.name
      const ctx: HookContext = {
        rootEnv,
        serverEnv: env,
        envPath,
        rootEnvPath,
        sshAddress: SSH_ADDRESS,
        sshUser: SSH_USER,
        pathApps: PATH_APPS,
        deployAs,
        installedStackNames: allStackNames,
      }
      try {
        await runHook(
          "after",
          stackConfig.name,
          stackFiles.get(stackConfig.name)?.files.get("after.deploy.ts"),
          stagingDir,
          ctx,
        )
      } catch (err) {
        if (err instanceof UserError) {
          console.error(err.message)
          afterFailures.push(stackConfig.name)
        } else {
          throw err
        }
      }
    }
    if (afterFailures.length > 0) {
      throw new UserError(`after.deploy.ts failed for stack(s): ${afterFailures.join(", ")}`)
    }

    console.log("Deployment script finished")
    return { deployedStacks: stacks.map((s) => s.name), results }
  } finally {
    // Remove staging first, synchronously, and only then drop the signal
    // listeners: with the listeners gone, a signal would take its default
    // action, so an async removal in that order left a window where a
    // Ctrl-C or closed terminal killed the process mid-delete with `.env`
    // still on disk. A signal that arrives during this synchronous
    // removal is handled right after it, by a handler whose own removal
    // finds nothing left. removeStagingDirSync warns if it can't remove.
    removeStagingDirSync(stagingDir)
    removeSignalCleanup()
  }
}

/** Fill `${VAR}` placeholders in a stack's config.json `envs` and append to the staging .env. */
async function applyStackEnvs(
  stackConfig: StackConfig,
  serverEnv: Record<string, string>,
  stagingDir: string,
): Promise<void> {
  const envs = stackConfig.envs ?? {}
  for (const [key, value] of Object.entries(envs)) {
    if (typeof value !== "string") {
      throw new UserError(
        `invalid env value for key '${key}' in stack '${stackConfig.name}' (config.json): must be a string`,
      )
    }
    const filled = value.replace(/\$\{([^}]+)\}/g, (_match, varName) => {
      const resolvedValue = serverEnv[varName.trim()]
      if (resolvedValue === undefined) {
        throw new UserError(
          `environment variable '${varName.trim()}' not found for stack '${stackConfig.name}' ` +
            `(referenced in config.json envs)`,
        )
      }
      return resolvedValue
    })
    const stagingEnvPath = join(stagingDir, ".env")
    const current = await Deno.readTextFile(stagingEnvPath)
    if (!current.includes(`${key}=`)) {
      await Deno.writeTextFile(stagingEnvPath, `${current}\n${key}=${filled}\n`)
    }
  }
}

/**
 * Remove `dir` synchronously, retrying up to 3 times on failure — one
 * write the main deploy flow started before the signal can still land
 * inside `dir`, so a first `ENOTEMPTY`-style failure right after a
 * signal isn't necessarily permanent. Never throws; logs a warning if it still
 * can't remove the directory after every retry.
 */
function removeStagingDirSync(dir: string): void {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      Deno.removeSync(dir, { recursive: true })
      return
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return // already gone
      if (attempt === 3) {
        console.error(`Warning: failed to remove staging directory ${dir}: ${err}`)
        return
      }
      const until = Date.now() + 50
      while (Date.now() < until) { /* brief synchronous pause before retrying */ }
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path)
    return true
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false
    throw err
  }
}

async function copyIfExists(src: string, dest: string): Promise<void> {
  let info: Deno.FileInfo
  try {
    info = await Deno.stat(src)
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return
    throw err
  }
  if (info.isDirectory) {
    await copyDirRecursive(src, dest)
  } else if (info.isFile) {
    await Deno.mkdir(dirname(dest), { recursive: true })
    await Deno.copyFile(src, dest)
  }
}

async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await Deno.mkdir(dest, { recursive: true })
  for await (const entry of Deno.readDir(src)) {
    const s = join(src, entry.name)
    const d = join(dest, entry.name)
    if (entry.isDirectory) await copyDirRecursive(s, d)
    else if (entry.isFile) await Deno.copyFile(s, d)
  }
}

/** Fetch `url` (file:// or https://) and write its bytes to `destPath`, creating parent dirs. */
async function fetchToFile(url: string, destPath: string): Promise<void> {
  await Deno.mkdir(dirname(destPath), { recursive: true })
  const resp = await fetch(url)
  if (!resp.ok) {
    throw new Error(`failed to fetch ${url}: HTTP ${resp.status}`)
  }
  const bytes = new Uint8Array(await resp.arrayBuffer())
  await Deno.writeFile(destPath, bytes)
}

function entriesToRecord(entries: { key: string; value: string }[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const { key, value } of entries) out[key] = value
  return out
}

/** Signals that end a deploy early, with the shell's exit code for each (128 + signal number). */
export const STAGING_CLEANUP_SIGNALS = [
  { signal: "SIGHUP", code: 129 },
  { signal: "SIGINT", code: 130 },
  { signal: "SIGQUIT", code: 131 },
  { signal: "SIGTERM", code: 143 },
] as const

/**
 * The work a deploy does when a signal ends it early: kill every child
 * process deploy started, remove the staging dir, and exit with the
 * signal's code. Fully synchronous — it must never yield to the event
 * loop, or the deploy's own pending file writes run between its steps
 * and recreate the staging dir (see the comment in `runDeploy`).
 * `exit` is injectable so a test can call this directly.
 */
export function handleStagingSignal(
  stagingDir: string,
  code: number,
  exit: (code: number) => void = Deno.exit,
): void {
  killActiveChildren()
  removeStagingDirSync(stagingDir)
  exit(code)
}

/**
 * Register `handleStagingSignal` for every signal in
 * `STAGING_CLEANUP_SIGNALS`. Returns a function that removes the
 * listeners again, called once the deploy finishes normally.
 */
export function installStagingSignalCleanup(stagingDir: string): () => void {
  const listeners = STAGING_CLEANUP_SIGNALS.map(({ signal, code }) => {
    const listener = () => handleStagingSignal(stagingDir, code)
    Deno.addSignalListener(signal, listener)
    return { signal, listener }
  })
  return () => {
    for (const { signal, listener } of listeners) Deno.removeSignalListener(signal, listener)
  }
}
