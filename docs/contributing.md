# Contributing

Thanks for considering a contribution to `rostok`. This repo is the
**catalog** of services plus the **CLI** source. Both are welcome.

## What you can contribute

- **New stack** — add a service to the catalog. See
  [adding-services.md](adding-services.md).
- **Bug fix** — including type errors, broken deploys, Travis-style
  config issues.
- **CLI improvement** — the CLI is in active development. See
  [v1-cli.md](v1-cli.md) for the design.
- **Documentation** — fix typos, add examples, clarify the wizard
  flow.
- **Test** — golden-file fixtures for `cli/server-create` and
  `cli/stack-add` are very welcome.

## Before opening a PR

1. **Read [AGENTS.md](../AGENTS.md)** — git workflow, branch naming,
   commit convention, review process.
2. **Read [v1-cli.md](v1-cli.md)** — if your change touches the CLI
   design, the design doc is the source of truth. Update it first.
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

If you add a new stack, smoke-test it:

```bash
# In a fresh test folder
mkdir /tmp/rostok-test && cd /tmp/rostok-test
deno install -A -n rostok jsr:@rostok/cli
rostok --non-interactive --server=test --stacks=your-new-stack
# ... or use the test fixtures under cli/ once v1 ships
```

For more thorough testing, run `deno task check` and verify the type
checker walks through `stacks/<name>/compose.yml` references.

## Style

- TypeScript: `deno fmt` defaults. No bikeshedding.
- Markdown: same — `deno fmt` covers `.md` files.
- Commit messages: imperative mood, no AI attribution.

## Code of conduct

Be kind. We're all building this for fun. Disagreements on design
happen in the issue, not in the PR thread.

## License

By contributing, you agree your contribution is licensed under [MIT](../LICENSE).
