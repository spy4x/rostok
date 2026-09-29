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

### OpenCode MCP

OpenCode can connect to the Playwright MCP server for browser automation tasks by configuring the MCP client to use the WebSocket endpoint.

## Usage

No direct access needed - services connect via Docker network.

## Variables

No variables: compose reads none, and nothing is routed through Traefik. Other containers reach the server at `ws://playwright:3000` and the MCP proxy at `http://hl-playwright-mcp:8099`.

| Key | Default | Meaning |
| --- | ------- | ------- |

## Resources

- [Playwright Documentation](https://playwright.dev/)
- [Playwright Docker Guide](https://playwright.dev/docs/docker)
