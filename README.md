<div align="center">

# rostok 🌱

**Scaffold a self-hosted homelab from a curated catalog.**

[![CI](https://ci.antonshubin.com/api/badges/2/status.svg)](https://ci.antonshubin.com/repos/2)
[![JSR](https://jsr.io/badges/@rostok/cli)](https://jsr.io/@rostok/cli)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[**See my servers live →**](https://dash.antonshubin.com) ·
[Commands](docs/commands.md) · [How it works](docs/how-it-works.md) ·
[Catalog](docs/usage/catalog.md) · [All docs](docs/README.md)

![A terminal runs "rostok stack list", which lists seven stacks by category, then "rostok": the wizard creates the project, generates an encryption key, asks for the server's name, SSH address, domain and email, keeps the defaults for the rest, adds librespeed and traefik, and prints the next step, "rostok deploy home".](docs/screenshots/demo.gif)

</div>

Run `rostok` in an empty folder and answer a few questions: the server's name,
its SSH address, your domain and email. The wizard turns that into a Git repo
with one folder per server, adds the stacks you pick from the catalog, fills in
their settings and, once you let it generate a key, encrypts the `.env` files
so the repo is safe to push. `rostok deploy home` then copies the files to the
server over SSH and starts them with Docker Compose.

**росток** is Russian for "sprout". rostok grew out of the repo that runs my own
servers, and I still deploy my services from it: this repository's stacks and
deploy code run my machines, and
[dash.antonshubin.com](https://dash.antonshubin.com) shows them live.

## Why rostok

- **One command to start.** `rostok` creates the project, asks for the server's
  settings and adds the stacks you pick.
- **Plain files in Git.** Each server is a folder with a `config.json` and a
  `.env`. No database, no daemon, no web UI.
- **Secrets you can commit.** Every value is encrypted on its own into
  `.env.age` with age, in-process, with no extra binary to install.
- **Deploys over SSH.** `rostok deploy` rsyncs a server's files and runs
  `docker compose` there. No agent to install on the server.
- **Sensible defaults.** Each stack's `+meta.ts` declares its variables with
  defaults; the wizard asks only for what has none, and checks the server's
  name, SSH address and paths before writing anything.
- **Standard parts.** The CLI is a TypeScript ES module on JSR that runs on
  Deno; every stack is an ordinary Docker Compose file you can read and change.

**Use it if** you run Docker on one to a few machines (an old PC, a homelab, or
a small company replacing SaaS) and want the setup in a Git repo. **Skip it if**
you run a big company's fleet: rostok stays small and homelab-shaped.

## Quick start

Requires [Deno](https://deno.land) 2.0 or newer.

```bash
deno install -g -A -n rostok jsr:@rostok/cli
mkdir ~/rostok && cd ~/rostok
rostok                       # wizard: init → server create → stack add
rostok stack list            # browse the bundled catalog
rostok deploy home           # deploy what you configured
```

The wizard writes `deno.jsonc`, initialises git, and creates
`servers/<name>/` with your chosen stack. Every `.env` mutation is
auto-encrypted to `.env.age` (once a key exists — `rostok env setup`),
so secrets are safe to commit. Every command and flag:
[docs/commands.md](docs/commands.md).

## What you get

After `$ rostok`, your project folder holds:

```
.
├── deno.jsonc              # imports map for @rostok/cli
├── .gitignore              # ignores plaintext .env / .env.root
├── .env.root               # CLI-managed cross-server vars (gitignored)
├── .env.root.age           # encrypted — safe to commit
└── servers/
    └── home/
        ├── config.json     # which stacks (CLI-managed, committed)
        ├── .env            # per-server vars (gitignored)
        └── .env.age        # encrypted — safe to commit
```

Full layout + ownership rules: [`docs/design/v1-cli.md`](docs/design/v1-cli.md).
Concepts, architecture, encryption and disaster recovery:
[`docs/README.md`](docs/README.md).

## Development

```bash
deno run -A cli/+main.ts --help   # the CLI from this checkout
deno task check                   # lint, fmt, types, tests
```

See [`docs/contributing/contributing.md`](docs/contributing/contributing.md).
New stacks are welcome — open a PR with a `stacks/<name>/+meta.ts`
plus the usual `compose.yml`, `backup.ts`, `README.md`. See
[`docs/contributing/adding-services.md`](docs/contributing/adding-services.md)
for the schema.

## Built by

I'm [Anton Shubin](https://antonshubin.com), a senior full-stack engineer and
tech lead. rostok is one of the tools I build and use to run my own servers.
Need something like it built for your product?
[That's my day job →](https://antonshubin.com)

Licensed under [MIT](LICENSE).

---

Made by Anton Shubin · [antonshubin.com/tools](https://antonshubin.com/tools)
