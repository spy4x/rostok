# GitHub mirror

Keeps a copy of every GitHub repository of one account in your Gitea, public and private, so your
code does not depend on GitHub.

Once an hour a small Deno script (`mirror.ts`) lists the repositories the GitHub token's account
owns and asks Gitea to create a [pull mirror](https://docs.gitea.com/usage/repo-mirror) for each one
Gitea does not have yet. Gitea then pulls every mirror on its own schedule (`[mirror]
DEFAULT_INTERVAL`, 8 hours unless you change it). A new GitHub repository shows up in Gitea within
the hour, with no manual step.

The script never deletes or changes a repository. A repository deleted on GitHub keeps its last
copy in Gitea; one renamed on GitHub gets a second mirror under its new name. A Gitea repository
that already has the same name is left alone.

What a mirror holds: the Git data (branches and tags). Issues, pull requests, releases and wikis
are not copied.

## Tokens

- `GITHUB_MIRROR_GITHUB_TOKEN`: a GitHub
  [fine-grained personal access token](https://github.com/settings/personal-access-tokens) for your
  account, with repository access "All repositories" and the permissions Contents: read and
  Metadata: read. Gitea stores it with each mirror to pull private repositories, so give it no
  write permission. When it expires, every mirror of a private repository stops updating until
  you replace it in each mirror's settings (Gitea keeps its own copy).
- `GITHUB_MIRROR_GITEA_TOKEN`: a Gitea access token of the user who will own the mirrors, with
  the scopes `write:repository` and `read:user`. Create it under Settings, Applications.

## Access

No web UI and no Traefik route. The container calls the GitHub API and Gitea's API at
`http://hl-gitea:3000` on the `proxy` network, so it skips Traefik and Authelia. Its log
(`docker logs hl-github-mirror`) has one line per pass and names every repository that failed.

## Backup

Stateless: the mirrors live in Gitea, and the `gitea` stack's backup covers them.

## Variables

Declared in `+meta.ts`. Requires the `gitea` stack. Ships `compose.yml` and `mirror.ts`.

| Key                          | Default       | Meaning                                       |
| ---------------------------- | ------------- | --------------------------------------------- |
| `GITHUB_MIRROR_GITHUB_TOKEN` | asked, secret | GitHub token that reads all your repositories |
| `GITHUB_MIRROR_GITEA_TOKEN`  | asked, secret | Gitea token of the user that owns the mirrors |

## Image tags

Each image takes its tag from its own variable; unset, compose uses the default below.
Under `IMAGE_POLICY=pinned`, `rostok stack add` writes the exact version, and
`rostok images update` moves it (see [commands](../../docs/commands.md)).

| Variable                  | Default        | Image                                     |
| ------------------------- | -------------- | ----------------------------------------- |
| `GITHUB_MIRROR_IMAGE_TAG` | `alpine-2.9.7` | `denoland/deno` (service `github-mirror`) |
