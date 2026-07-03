# monica-mcp

MCP server providing Monica CRM access to AI assistants.

## Features

- Exposes Monica contacts, activities, and relationships as MCP tools
- Custom Docker build (see `Dockerfile`)
- Used by OpenCode AI for contact management
- No external web exposure — Docker DNS only

## Access

Internal MCP server — no web UI. Reached via Docker DNS at `hl-monica-mcp:3000`.

## Configuration

```bash
MONICA_BASE_URL=https://crm.${DOMAIN}
MONICA_API_TOKEN=${MONICA_API_TOKEN}
MONICA_TOKEN_TYPE=bearer
```

## Resources

- [Monica MCP Source](../stacks/monica-mcp/)
- [Monica API Docs](https://docs.monicahq.com/api)
