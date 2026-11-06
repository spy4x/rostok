# Commands

What every `rostok` command and flag does. The two-minute version is the
[Quick start](../README.md#quick-start) in the README.

## Install

The single binary, for Linux and macOS on x64 and arm64, needs no Deno:

```bash
curl -fsSL https://raw.githubusercontent.com/spy4x/rostok/main/install.sh | sh
curl -fsSL https://raw.githubusercontent.com/spy4x/rostok/main/install.sh | sh -s -- 1.24.0
```

`install.sh` downloads `rostok-<platform>.gz` and `SHA256SUMS` from the
[GitHub release](https://github.com/spy4x/rostok/releases), refuses a file
whose checksum does not match, and installs to `~/.local/bin/rostok`
(`ROSTOK_INSTALL=<dir>` installs elsewhere). It says how to add the folder to
`PATH` when it is not there yet.

Or install from JSR with [Deno](https://deno.land) ≥ 2.0:

```bash
deno install -g -A -n rostok jsr:@rostok/cli
```

`-g`/`--global` is required on Deno 2 for a named executable install
(`deno install -A -n rostok ...` alone errors with "the following required
arguments were not provided: --global").

Encryption is optional but endorsed — the wizard runs to completion without
a key, and your `.env` files stay plaintext (gitignored). No extra binary to
install: encryption runs in-process (`@spy4x/server/env-age64`). The wizard
offers to generate a key for you so `.env.age` files are safe to commit.

### Upgrading

`rostok upgrade` (or `rostok update`) replaces the binary with the latest
release, `rostok upgrade 1.24.0` with a given one. It checks the download
against `SHA256SUMS`, runs the new binary once with `--version`, and only then
swaps it in. When the binary's folder is not writable, it says so: run it as
that folder's owner, e.g. with `sudo`. A JSR install prints the
`deno install … --force` command to run instead.

At most once a day, a command also asks GitHub for the latest version while it
runs, and prints one line after its own output when a newer one exists:

```
rostok 1.25.0 is available (you have 1.24.0). Run: rostok upgrade
```

The check never delays a command by more than a moment and stays silent when
the network is down. It is skipped for `upgrade`, `--version` and `--help`,
when the output is not a terminal, when `CI` is set, and with
`ROSTOK_NO_UPDATE_CHECK=1`. It remembers the last check in
`$XDG_CACHE_HOME/rostok/update-check.json` (default `~/.cache/rostok/`).

## Commands

| Command                                      | What it does                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| `rostok`                                     | Onboarding wizard: init + server create + stack add                              |
| `rostok server create [<name>]`              | Create a server (one of the wizard steps, standalone)                            |
| `rostok stack add <name> --server=<name>`    | Add a stack to a server from the bundled catalog                                 |
| `rostok stack list [--tree] [--format json]` | Browse the catalog. `--tree` indents under category, `--format json` for scripts |
| `rostok deploy <server> [stack]`             | Deploy — rsyncs the server's files and runs `docker compose` over SSH, or locally for `SSH_ADDRESS=local` |
| `rostok images outdated [server]`           | List each pinned image next to the newest version the registry has               |
| `rostok images update <server> [stack]`      | Move the outdated pins in the server's `.env`. Does not deploy                   |
| `rostok env encrypt`                         | Encrypt `.env` → `.env.age` (per-server + root, and each `configs/<app>.env`)    |
| `rostok env decrypt`                         | Decrypt `.env.age` → `.env`                                                      |
| `rostok env status`                          | Encryption posture + next steps                                                  |
| `rostok llms [--check]`                      | Write `llms.txt`, the map of services for AI agents. `--check` fails when it is out of date. [Details](#service-map-for-ai-agents) |
| `rostok env setup`                           | Generate `.age/key.txt` — `rostok` hides the key generation for you              |
| `rostok offline status`                      | Backup paths, disks and tools for the external-drive copy. Changes nothing       |
| `rostok offline backup --drive <disk>`       | Copy the restic repositories to the external drive, check them, SMART test, eject |
| `rostok offline verify --drive <disk>`       | Check the copies on the drive and run a SMART test; copies nothing               |
| `rostok offline restore --drive <disk>`      | Copy the drive back over the local backup folders, then check them               |
| `rostok offline format --drive <disk>`       | Erase a disk and create the `OfflineBackups` partition                           |
| `rostok upgrade [version]`                   | Replace this binary with the latest (or the given) release. Alias `update`       |
| `rostok --help`, `rostok --version`          | Self-explanatory                                                                 |

Flags:

| Flag                      | Meaning                                                                          |
| ------------------------- | -------------------------------------------------------------------------------- |
| `-n`, `--non-interactive` | Skip prompts, use defaults (every required var must have a default or a `--var`) |
| `--server=<name>`         | Target server for `stack add` (`deploy` takes the server as a positional arg)    |
| `--var KEY=VAL`           | Repeatable. Overrides one variable for the current command                       |

A `--var` value is taken whole, commas included (`--var WIREGUARD_PEERS=phone,laptop`).
`stack add` refuses a `--var` key that neither the stack nor a stack it requires declares, and
names the keys it does declare.

## Service map for AI agents

`rostok llms`, run from the project root, writes `llms.txt` there: every stack of every server,
with its URLs, its catalog description and your notes, in three sections. An AI agent reads it to
find a service, such as ntfy to notify you, and to learn whether it may use it. Two optional
fields on a stack entry in `servers/<server>/config.json` decide where a stack goes:

| Field      | Type    | Meaning                                                                       |
| ---------- | ------- | ----------------------------------------------------------------------------- |
| `aiCanUse` | boolean | `true`: agents may use it. `false`: they must not. Unset: ask the owner first |
| `aiNotes`  | string  | How an agent should use it, such as where its token is and which topic to use |

```json
{ "stacks": [{ "name": "ntfy", "aiCanUse": true, "aiNotes": "token NTFY_TOKEN, topic agents" }] }
```

A URL is `https://` plus each of the stack's own `*_DOMAIN` keys in the plaintext `.env.root` and
server `.env`, with `${SERVER_NAME}` and `${DOMAIN}` filled in. No other value of those files
reaches `llms.txt`, but run `rostok env decrypt` first: a server without a `.env` is an error.
Deploy checks the two fields' types and otherwise ignores them. Change a field, then rerun
`rostok llms`; `rostok llms --check` exits non-zero when the file is out of date and writes
nothing, so CI or a hook can catch a stale map.

## Image versions

`IMAGE_POLICY` decides whether a stack's images stay on the version you
added them with, or follow the newest one.

| Value              | What `rostok stack add` does                                                         |
| ------------------ | ------------------------------------------------------------------------------------ |
| `pinned` (default) | Asks the registry which version each image is today and writes it into the server's `.env`, for example `GATUS_IMAGE_TAG=v5.12.1` |
| `latest`           | Writes no pin. Images keep the floating tag from the stack's compose file            |

Set it for the whole project in `.env.root`. A server's own
`servers/<name>/.env` wins when it sets `IMAGE_POLICY` too. The wizard
asks once and writes your answer to `.env.root`; with `-n` it takes
`--var IMAGE_POLICY=latest`, or `pinned` when you pass nothing. Any
other value stops the command with an error that names the file.

How a pin is chosen, under `pinned`:

- rostok reads the digest behind the image's default tag (`latest`,
  `alpine`, `16`) and looks for a version tag with the same digest.
  That version is the pin.
- When no version tag shares the digest, the pin is the digest itself:
  `latest@sha256:…`. Docker accepts both forms.
- When the default tag is itself a version, the pin never leaves that
  major version: `16` becomes `16.9`, never `17.x`. A full version such
  as `3.7.6` is already exact and is written as it is.
- A tag variable that already has a value in the server's `.env`, or
  that you pass with `--var`, is never overwritten. The one exception is
  `latest` already in `.env` (left there while the policy was `latest`):
  it is pinned like an unset variable, and `stack add` says so.
- A registry that cannot be reached, or that rate-limits you, does not
  stop `stack add`. You get one warning that names the image, its
  variable stays unset, and running the same `stack add` again pins it.
- A rostok installed from JSR downloads the stack's compose file to
  learn its tag variables. When that download fails (no connection, no
  answer within 10 seconds, or any answer but 200), `stack add` still
  adds the stack. You get one warning that names the stack, and no
  default is written for a variable named `*_IMAGE_TAG`, so it stays
  unset and running the same `stack add` again pins it. A tag variable
  with another name keeps the default from the stack's `+meta.ts`.

Only images whose tag is a variable in the compose file
(`image: name:${SOME_IMAGE_TAG:-latest}`) are pinned; an image with a
hardcoded tag, or with none, is left as it is for now. Docker Hub, GHCR
and Quay are supported, read anonymously.

### `rostok images outdated [server]`

Lists every tag variable of the server's stacks (every server, when you
name none) with where it stands: the newest version next to an outdated
pin, `(newest)`, or `(not pinned)` for a floating tag. A version pin is
compared with newer tags of the same form (`v` prefix, suffix such as
`-alpine`, and number of parts); pre-releases are skipped. When the
compose default is a version, only the pin's own major version counts.
A digest pin is compared with the digest its tag has now. It changes
nothing. A registry that cannot be asked is shown on that pin's line.
When a stack's compose file cannot be downloaded (see above), this
command and `images update` stop with an error that names the stack,
before anything is written.

### `rostok images update <server> [stack]`

Rewrites the outdated pins in `servers/<server>/.env` (only the one
stack's, when you name it), re-encrypts, and prints for each moved pin
the image's source link (its `org.opencontainers.image.source` label)
or, when it has none, its registry page, so you can read what changed.
It does not deploy: run `rostok deploy <server>` afterwards. Floating
tags and unset variables are not touched. A new version tag is written only when the
registry serves its manifest; one it lists but cannot serve gets a
warning, and its pin stays as it was.
