# Commands

What every `rostok` command and flag does. The two-minute version is the
[Quick start](../README.md#quick-start) in the README.

## Install

```bash
deno install -g -A -n rostok jsr:@rostok/cli
```

Requires [Deno](https://deno.land) ≥ 2.0 — `-g`/`--global` is required
on Deno 2 for a named executable install (`deno install -A -n rostok
...` alone errors with "the following required arguments were not
provided: --global"). Encryption is optional but endorsed — the wizard
runs to completion without a key, and your `.env` files stay plaintext
(gitignored). No extra binary to install: encryption runs in-process
(`@spy4x/server/env-age64`). The wizard offers to generate a key for you
so `.env.age` files are safe to commit.

## Commands

| Command                                      | What it does                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| `rostok`                                     | Onboarding wizard: init + server create + stack add                              |
| `rostok server create [<name>]`              | Create a server (one of the wizard steps, standalone)                            |
| `rostok stack add <name> --server=<name>`    | Add a stack to a server from the bundled catalog                                 |
| `rostok stack list [--tree] [--format json]` | Browse the catalog. `--tree` indents under category, `--format json` for scripts |
| `rostok deploy <server> [stack]`             | Deploy — rsyncs the server's files and runs `docker compose` over SSH            |
| `rostok env encrypt`                         | Encrypt `.env` → `.env.age` (per-stack + root)                                   |
| `rostok env decrypt`                         | Decrypt `.env.age` → `.env`                                                      |
| `rostok env status`                          | Encryption posture + next steps                                                  |
| `rostok env setup`                           | Generate `.age/key.txt` — `rostok` hides the key generation for you              |
| `rostok --help`, `rostok --version`          | Self-explanatory                                                                 |

Flags:

| Flag                      | Meaning                                                                          |
| ------------------------- | -------------------------------------------------------------------------------- |
| `-n`, `--non-interactive` | Skip prompts, use defaults (every required var must have a default or a `--var`) |
| `--server=<name>`         | Target server for `stack add` (`deploy` takes the server as a positional arg)    |
| `--var KEY=VAL`           | Repeatable. Overrides one variable for the current command                       |

