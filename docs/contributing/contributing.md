# Contributing

Thanks for considering a contribution to `rostok`. This repo is the
**catalog** of services plus the **CLI** source. Both are welcome.

## What you can contribute

- **New stack** — add a service to the catalog. See
  [adding-services.md](adding-services.md).
- **Bug fix** — including type errors, broken deploys, Travis-style
  config issues.
- **CLI improvement** — the CLI is in active development. See
  [v1-cli.md](../design/v1-cli.md) for the design.
- **Documentation** — fix typos, add examples, clarify the wizard
  flow.
- **Test** — golden-file fixtures for `cli/server-create` and
  `cli/stack-add` are very welcome.

## Before opening a PR

1. **Read [AGENTS.md](../../AGENTS.md)** — git workflow, branch naming,
   commit convention, review process.
2. **Read [v1-cli.md](../design/v1-cli.md)** — if your change touches
   the CLI design, the design doc is the source of truth. Update it
   first.
3. **Run `deno task check`** — lint, fmt, type-check, tests. All must
   pass.

## Branch & commit

- Branch: `feat/<short-kebab>`, `fix/<short-kebab>`, `docs/<short-kebab>`
- Commit: Angular convention, `<type>(<scope>): <summary>`
- Subject ≤ 50 chars, hard cap 72
- One logical change per commit

## PR checklist

- [ ] `deno task check` passes
- [ ] Branch is up to date with `main`
- [ ] PR description explains *why*, not just *what*
- [ ] New stacks have all 4 files (`compose.yml`, `backup.ts` if
      stateful, `README.md`, `+meta.ts` for v1)
- [ ] No hardcoded secrets, domains, IPs in the diff
- [ ] `stacks/<name>/` matches the conventions in
      [adding-services.md](adding-services.md)
- [ ] Public docs updated if behaviour changes
- [ ] Linked to an issue if one exists

## Review process

1. Open PR. Reviewer (robot or human) checks the diff.
2. Robot reviews for **secrets, real hostnames, large unrelated
   changes**. Blocking.
3. Human reviews for **design fit** — does the stack/CLI change fit the
   vision of `rostok`?
4. Merge via squash (default) or rebase (independent commits).
5. Branch is deleted after merge.

## Local stack testing

If you add a new stack, smoke-test it with the CLI from your checkout.
The published `rostok` does not know a stack until it is released, and
the checkout knows it only once its `+meta.ts` is registered in
`cli/catalog.ts`:

```bash
# In a fresh test folder
cd "$(mktemp -d)"
deno run -A <checkout>/cli/+main.ts server create test -n \
  --var SSH_ADDRESS=local --var DOMAIN=example.com --var CONTACT_EMAIL=a@example.com
deno run -A <checkout>/cli/+main.ts stack add your-new-stack -s test -n
```

The CLI's own tests sit next to their code under `cli/` (`*.test.ts`).

`deno task check` also runs `cli/catalog.test.ts`, which checks that
every stack's `+meta.ts` agrees with its `compose.yml` and hooks.

## Real-server test

`deno task e2e:vps` does what a new user does, on a real machine: it
creates the cheapest x86 Hetzner Cloud server with a throwaway SSH
key, installs rostok, runs the wizard, adds traefik, gatus, librespeed
and piped, deploys, and then checks that every container is healthy,
that each service answers over HTTPS, that the `.env` files are mode
600 and that a second deploy changes nothing. Then it deletes the
server and the key, also when it fails, you press Ctrl-C or you
close the terminal. A run
takes about ten minutes and costs under one cent.

```bash
# rostok from this checkout — before a release
T="$(sed -n 's/^HETZNER_CLOUD_API_TOKEN=//p' <your env file>)" && \
  HETZNER_CLOUD_API_TOKEN="$T" deno task e2e:vps local

# rostok from JSR at a version — after it is published
T="$(sed -n 's/^HETZNER_CLOUD_API_TOKEN=//p' <your env file>)" && \
  HETZNER_CLOUD_API_TOKEN="$T" deno task e2e:vps 1.11.0
```

- It needs a Hetzner Cloud API token with read and write access, and
  `ssh`, `ssh-keygen`, `rsync` and `curl` on your machine. Give it the
  token for that one command, as above; do not export it.
- It runs on your machine only, never in CI: the build logs are
  public, and the token can create servers on the account.
- It deletes only servers and SSH keys labelled `rostok-e2e`. Every
  run also deletes labelled ones older than two hours, which a killed
  run may have left.
- It uses its own key, ssh config and `known_hosts` in a temp folder,
  and deletes the folder at the end. Your `~/.ssh` is not touched.
- The exit code is 0 only when every check passed and nothing is left
  behind. The last lines list each failed check.

## Style

- TypeScript: `deno fmt` defaults. No bikeshedding.
- Markdown: same — `deno fmt` covers `.md` files.
- Commit messages: imperative mood, no AI attribution.

## Versioning

The package version lives in two places — both must match every
release:

- `deno.jsonc` → `version` field (the JSR package version)
- `cli/version.ts` → `VERSION` export (what `rostok --version` prints)

If you bump one without the other, end users see
`deno.jsonc: 1.0.4` installed but `rostok 1.0.3`, and JSR versions
are immutable so the fix needs another release. See the "Releasing"
section of [AGENTS.md](../../AGENTS.md) for the full publish flow.

Convention: a release PR that bumps the version also includes any
related changes. Don't ship a version-only commit unless it's a
follow-up fix.

## Code of conduct

Be kind. We're all building this for fun. Disagreements on design
happen in the issue, not in the PR thread.

## License

By contributing, you agree your contribution is licensed under [MIT](../../LICENSE).
