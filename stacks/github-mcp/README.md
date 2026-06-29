# GitHub MCP Server

Exposes the [GitHub MCP Server](https://github.com/github/github-mcp-server) via
Streamable HTTP using [SuperGateway](https://github.com/supercorp-ai/supergateway).

## What it does

Provides AI assistants with GitHub API access: repositories, issues, pull requests,
Actions, code search, users, and more. Used by OpenWebUI and OpenHands.

## Setup

1. Add `GITHUB_TOKEN` to `servers/home/.env`:
   ```
   GITHUB_TOKEN=github_pat_YOUR_TOKEN
   ```
2. The stack is registered in `servers/home/config.json` and will be deployed
   automatically.

## Environment Variables

| Variable             | Required | Default  | Description                                                                            |
| -------------------- | -------- | -------- | -------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`       | Yes      | —        | GitHub Personal Access Token (from `servers/home/.env`)                                |
| `GITHUB_MCP_VERSION` | No       | `v1.5.0` | GitHub MCP server release tag                                                          |
| `GITHUB_TOOLSETS`    | No       | `*`      | Tool groups to enable (repos,issues,pull_requests,actions,code_security,users,context) |

## Tool Groups

Control which GitHub APIs are exposed via `GITHUB_TOOLSETS`:

- `repos` — list, create, update repos; get content, commits, branches
- `issues` — search, create, update, comment on issues
- `pull_requests` — search, create, update PRs; review, merge
- `actions` — list workflows, trigger runs, check status
- `code_security` — Dependabot, secret scanning, code scanning alerts
- `users` — get user info
- `context` — repo context for operations

Default (`*`) enables all tool groups.

## Consumers

| Consumer  | Connection                                                      |
| --------- | --------------------------------------------------------------- |
| OpenWebUI | `http://hl-github-mcp:3000/mcp` (via TOOL_SERVER_CONNECTIONS)   |
| OpenHands | `http://<container-ip>:3000/mcp` (via settings.json mcp_config) |
