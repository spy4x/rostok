# GitHub MCP Server

Exposes the [GitHub MCP Server](https://github.com/github/github-mcp-server) via
Streamable HTTP using a Node.js http-wrapper (routes JSON-RPC between HTTP
and the Go binary's stdio with session management).

## What it does

Provides AI assistants with GitHub API access: repositories, issues, pull requests,
Actions, code search, users, and more. Used by OpenWebUI and OpenCode Web.

## Setup

`rostok stack add github-mcp` asks for the token and writes it to the
server's `.env`. The stack builds its image from the `Dockerfile` next to
`compose.yml` and has no Traefik route, so it needs no domain and no
`traefik` stack.

## Variables

| Key                   | Default          | Meaning                                                                                |
| --------------------- | ---------------- | -------------------------------------------------------------------------------------- |
| `GITHUB_MCP_TOKEN`    | required, secret | GitHub personal access token (`repo` and `read:user` scopes at least)                  |
| `GITHUB_MCP_TOOLSETS` | `all`            | Tool groups to enable (repos,issues,pull_requests,actions,code_security,users,context) |
| `GITHUB_MCP_VERSION`  | `v1.5.0`         | GitHub MCP server release tag the image is built from                                  |

## Tool Groups

Control which GitHub APIs are exposed via `GITHUB_MCP_TOOLSETS`:

- `repos` — list, create, update repos; get content, commits, branches
- `issues` — search, create, update, comment on issues
- `pull_requests` — search, create, update PRs; review, merge
- `actions` — list workflows, trigger runs, check status
- `code_security` — Dependabot, secret scanning, code scanning alerts
- `users` — get user info
- `context` — repo context for operations

Default (`*`) enables all tool groups.

## Consumers

| Consumer  | Connection                                                    |
| --------- | ------------------------------------------------------------- |
| OpenWebUI | `http://hl-github-mcp:3000/mcp` (via TOOL_SERVER_CONNECTIONS) |
