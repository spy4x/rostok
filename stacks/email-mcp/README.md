# Email MCP

Email server MCP for AI assistants (Open WebUI, Claude Desktop, etc.).
Speaks IMAP + SMTP via the [Model Context Protocol](https://modelcontextprotocol.io/).

- **Upstream**: [ai-zerolab/mcp-email-server](https://github.com/ai-zerolab/mcp-email-server) (BSD-3-Clause)
- **Image**: `ghcr.io/ai-zerolab/mcp-email-server:latest`
- **Transport**: Streamable HTTP on port 9557
- **Backend**: any IMAP/SMTP server; by default `mail.${DOMAIN}`

## Why this MCP?

This MCP exposes a self-hosted mail server to AI agents without going through Gmail/OAuth. Same pattern as
`caldav-mcp` (events/todos): a thin HTTP MCP that
wraps a self-hosted protocol server.

## Tools exposed

| Tool                  | Description                                              |
| --------------------- | -------------------------------------------------------- |
| `list_accounts`       | List configured accounts                                 |
| `list_mailboxes`      | List IMAP folders (INBOX, Sent, Drafts, Trash, …)        |
| `get_mailbox_status`  | Unread count + total per folder                          |
| `search_emails`       | Search by sender, subject, body, date range              |
| `get_emails_content`  | Read full email (body + headers + attachment list)       |
| `send_email`          | Send new email with CC/BCC, plain or HTML                |
| `reply_email`         | Reply with proper `In-Reply-To` / `References` threading |
| `forward_email`       | Forward original content                                 |
| `move_email`          | Move between folders                                     |
| `delete_email`        | Trash or hard-delete                                     |
| `mark_email`          | Read/unread, flag/unflag                                 |
| `save_draft`          | Save draft to Drafts folder                              |
| `download_attachment` | Download attachment (disabled by default — see below)    |

## Setup

### 1. Ensure the IMAP/SMTP account exists

The account must already exist on your mail server (for Docker Mailserver:
`docker exec -it mailserver setup email add you@example.com`).

### 2. Add the variables

`rostok stack add email-mcp` asks for them and writes them to the server's
`.env`. `before.deploy.ts` renders them into `stacks/email-mcp/config.toml`
(mode 0600), which the container mounts as `/config.toml`. Do not commit the
rendered file. The deploy stops if a required key is missing.

## Variables

| Key                        | Default          | Meaning                                                     |
| -------------------------- | ---------------- | ----------------------------------------------------------- |
| `EMAIL_MCP_HOST`           | `mail.${DOMAIN}` | Mail server host: IMAP on 993 (TLS), SMTP on 587 (STARTTLS) |
| `EMAIL_MCP_USER`           | required         | Login and address of the first account                      |
| `EMAIL_MCP_PASSWORD`       | required, secret | Password of the first account                               |
| `EMAIL_MCP_ACCOUNT_NAME`   | `main`           | Account name the assistant sees for the first account       |
| `EMAIL_MCP_FULL_NAME`      | the address      | Display name of the first account                           |
| `EMAIL_MCP_USER_2`         | none             | Login and address of an optional second account             |
| `EMAIL_MCP_PASSWORD_2`     | none, secret     | Password of the second account (required with a user)       |
| `EMAIL_MCP_FULL_NAME_2`    | its address      | Display name of the second account                          |
| `EMAIL_MCP_ACCOUNT_NAME_2` | `second`         | Account name the assistant sees for the second account      |
| `EMAIL_MCP_VERIFY_SSL`     | `false`          | `true` verifies the mail server's certificate               |

The stack has no Traefik route, so it needs no domain and no `traefik` stack.

### 3. Deploy

```bash
rostok deploy <server>
```

### 4. Wire into Open WebUI

Add to `TOOL_SERVER_CONNECTIONS` in `stacks/open-webui/compose.yml`:

```json
{
  "url": "http://hl-email-mcp:9557/mcp",
  "type": "mcp",
  "auth_type": "none",
  "headers": {
    "Accept": "application/json, text/event-stream",
    "Content-Type": "application/json"
  },
  "info": {
    "id": "email-mcp",
    "name": "Email MCP",
    "description": "IMAP + SMTP via mail.example.com"
  },
  "config": {
    "enable": true,
    "access_grants": [{ "principal_type": "user", "principal_id": "*", "permission": "read" }]
  }
}
```

Then restart Open WebUI:

```bash
rostok deploy <server>
```

### 5. Verify

In Open WebUI chat:

> "List my mailboxes"
> "Show me unread emails in INBOX"
> "Send an email to test@example.com with subject 'hello' and body 'world'"

## TLS

`EMAIL_MCP_VERIFY_SSL` defaults to `false` because the default host is your
own mail stack, often behind a certificate the container does not trust
([#143](https://github.com/spy4x/rostok/issues/143) tracks a safer default).
Set it to `true` for a mail host with a public certificate.

## Attachment downloads (optional)

Disabled by default for safety. To enable, set
`MCP_EMAIL_SERVER_ENABLE_ATTACHMENT_DOWNLOAD=true` in `compose.yml`.
The LLM can then call `download_attachment` to save files to a path inside
the container. Mount a volume if you need files on the host.

## Second account

Set `EMAIL_MCP_USER_2` and `EMAIL_MCP_PASSWORD_2`; both accounts use the same
host and port settings. For more than two, extend `renderConfig` in
`before.deploy.ts` (mcp-email-server reads several `[[emails]]` blocks only
from the TOML file, not from env vars).

## Security notes

- DNS rebinding protection is enabled. Allowed hosts/origins are restricted
  to the email-mcp container, Open WebUI, and localhost.
- No Traefik labels — the MCP is only reachable from the proxy Docker network.
- Container has `no-new-privileges:true` and a 256M memory limit.
- The MCP holds your plaintext password in env. Rotate via
  `setup email update` on the mailserver if leaked.

## Troubleshooting

| Symptom                              | Cause                                  | Fix                                                               |
| ------------------------------------ | -------------------------------------- | ----------------------------------------------------------------- |
| `535 Authentication failed`          | Wrong password or missing account      | `setup email update you@example.com`                              |
| `Connection refused` on port 993/587 | Firewall blocks home → cloud           | Check cloud security group                                        |
| `CERTIFICATE_VERIFY_FAILED`          | Wrong cert or clock skew               | Verify `mail.${DOMAIN}` resolves to cloud, check `date`           |
| Tools not showing in Open WebUI      | TOOL_SERVER_CONNECTIONS misconfigured  | Check JSON syntax; restart Open WebUI container                   |
| 403 from MCP                         | DNS rebinding protection blocks origin | Add host to `MCP_ALLOWED_HOSTS` / origin to `MCP_ALLOWED_ORIGINS` |
