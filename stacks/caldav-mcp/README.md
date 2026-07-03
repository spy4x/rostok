# caldav-mcp

CalDAV MCP server providing calendar/todo access to AI assistants.

## Features

- Exposes CalDAV calendars/todos as MCP tools
- Native Deno implementation, zero npm dependencies
- Direct CalDAV protocol with proper VTODO/VEVENT support
- Used by OpenCode AI for calendar operations

## Access

Internal MCP server — no external web UI. Reached via Docker DNS at `hl-caldav-mcp:3000`.

## Configuration

```bash
CALDAV_URL=<caldav-server-url>
CALDAV_USERNAME=<username>
CALDAV_PASSWORD=<password>
```

## Resources

- [CalDAV MCP Source](../stacks/caldav-mcp/)
- [MCP Protocol](https://modelcontextprotocol.io/)
