# Playwright

Browser automation server for running Playwright tests and scripts remotely.

## Features

- Remote browser automation via WebSocket
- Supports Chromium, Firefox, and WebKit browsers
- Headless browser execution
- Used by OpenWebUI for web scraping and MCP integrations
- Can be used by OpenCode for browser automation tasks, once connected to the stack's network

## Configuration

The Playwright server runs on port 3000 internally and is accessible via WebSocket at:

```
ws://playwright:3000
```

Only containers on the stack's own network, `hl-playwright-mcp`, reach that address; see "Who
can reach the browsers" below.

## Integration

### OpenWebUI

OpenWebUI uses Playwright for web content loading and scraping. The integration is configured via environment variables in the OpenWebUI stack:

- `WEB_LOADER_ENGINE=playwright`
- `PLAYWRIGHT_WS_URL=ws://playwright:3000`

### MCP proxy

The second container, `hl-playwright-mcp`, serves the Playwright MCP tools at
`http://hl-playwright-mcp:8099/mcp`. It starts its own browser and does not use the server on
port 3000.

### Who can reach the browsers

Neither the browser server on port 3000 nor the MCP endpoint has authentication, and whoever
reaches either one drives a browser inside your network. So neither is on the shared `proxy`
network. Both sit on a network of their own, `hl-playwright-mcp`, and run as the unprivileged
`pwuser`, with every Linux capability dropped and `no-new-privileges` set. Chromium runs
without its own sandbox, so these container limits are what contains a page that breaks out of
the browser. Docker's default seccomp filter stays on: Chromium's sandbox would need it turned
off, which is the worse trade.

Open WebUI is the one client. Compose cannot attach another stack's container, so two deploy
hooks connect `hl-open-webui` to that network: this stack's `after.deploy.ts` and Open WebUI's
own. A deploy of the whole server runs both, `rostok deploy <server> playwright` runs the first
and `rostok deploy <server> open-webui` the second, so each of these leaves Open WebUI connected.
Each hook does nothing when the other stack is not on the server, and on a local server
(`SSH_ADDRESS=local`) it uses the local `docker`. Open WebUI's addresses stay the same:
`ws://playwright:3000` resolves on that network too.

Two things to do by hand:

- **Upgrading a server that already runs this stack:** run `rostok deploy` once. It moves both
  containers to the new network and connects Open WebUI. Then check:

  ```bash
  docker exec hl-playwright id -u       # not 0
  docker exec hl-playwright-mcp id -u   # not 0
  docker network inspect hl-playwright-mcp -f '{{range .Containers}}{{.Name}} {{end}}'
  # hl-playwright hl-playwright-mcp hl-open-webui
  ```

- **After recreating `hl-open-webui` without `rostok deploy`** (`docker compose up` by hand), the
  connection is gone and the browser tool fails. Deploy either stack, or run
  `docker network connect hl-playwright-mcp hl-open-webui`.

To let another container use either browser, connect it the same way. Do not put
`hl-playwright` or `hl-playwright-mcp` back on `proxy`.

## Usage

No direct access needed - services connect via Docker network.

## Variables

Nothing is routed through Traefik. Only Open WebUI, and any container you connect to
`hl-playwright-mcp` yourself, reaches the two browsers.

| Key                    | Default         | Meaning                                                            |
| ---------------------- | --------------- | ------------------------------------------------------------------ |
| `PLAYWRIGHT_IMAGE_TAG` | `v1.60.0-noble` | Image tag of `mcr.microsoft.com/playwright` (service `playwright`) |

The MCP proxy (service `playwright-mcp`) is built from `Dockerfile.mcp-proxy`, whose base image
is pinned there, so it has no tag variable.

## Resources

- [Playwright Documentation](https://playwright.dev/)
- [Playwright Docker Guide](https://playwright.dev/docs/docker)
