# Playwright

Browser automation server for running Playwright tests and scripts remotely.

## Features

- Remote browser automation via WebSocket
- Supports Chromium, Firefox, and WebKit browsers
- Headless browser execution
- Used by OpenWebUI for web scraping and MCP integrations
- Can be used by OpenCode for browser automation tasks

## Configuration

The Playwright server runs on port 3000 internally and is accessible via WebSocket at:

```
ws://playwright:3000
```

## Integration

### OpenWebUI

OpenWebUI uses Playwright for web content loading and scraping. The integration is configured via environment variables in the OpenWebUI stack:

- `WEB_LOADER_ENGINE=playwright`
- `PLAYWRIGHT_WS_URL=ws://playwright:3000`

### MCP proxy

The second container, `hl-playwright-mcp`, serves the Playwright MCP tools at
`http://hl-playwright-mcp:8099/mcp`. The endpoint has no authentication, and whoever reaches it
drives a browser inside your network. So it is not on the shared `proxy` network. It sits on a
network of its own, `hl-playwright-mcp`, and its Chromium runs as the unprivileged `pwuser`.

Open WebUI is the one client. Compose cannot attach another stack's container, so two deploy
hooks connect `hl-open-webui` to that network: this stack's `after.deploy.ts` and Open WebUI's
own. A deploy of the whole server runs both, `rostok deploy <server> playwright` runs the first
and `rostok deploy <server> open-webui` the second, so each of these leaves Open WebUI connected.
Each hook does nothing when the other stack is not on the server, and on a local server
(`SSH_ADDRESS=local`) it uses the local `docker`. Open WebUI's tool server address stays the same.

Two things to do by hand:

- **Upgrading a server that already runs this stack:** run `rostok deploy` once. It moves
  `hl-playwright-mcp` to the new network and connects Open WebUI. Then check:

  ```bash
  docker exec hl-playwright-mcp id -u   # not 0
  docker network inspect hl-playwright-mcp -f '{{range .Containers}}{{.Name}} {{end}}'
  # hl-playwright-mcp hl-open-webui
  ```

- **After recreating `hl-open-webui` without `rostok deploy`** (`docker compose up` by hand), the
  connection is gone and the browser tool fails. Deploy either stack, or run
  `docker network connect hl-playwright-mcp hl-open-webui`.

To let another container use the MCP proxy, connect it the same way. Do not put
`hl-playwright-mcp` back on `proxy`.

## Usage

No direct access needed - services connect via Docker network.

## Variables

No variables: compose reads none, and nothing is routed through Traefik. Containers on `proxy`
reach the browser server at `ws://playwright:3000`; only Open WebUI reaches the MCP proxy.

| Key | Default | Meaning |
| --- | ------- | ------- |

## Resources

- [Playwright Documentation](https://playwright.dev/)
- [Playwright Docker Guide](https://playwright.dev/docs/docker)
