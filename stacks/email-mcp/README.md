# Email MCP

Email server MCP for AI assistants (Open WebUI, Claude Desktop, etc.).
Speaks IMAP + SMTP via the [Model Context Protocol](https://modelcontextprotocol.io/).

- **Upstream**: [ai-zerolab/mcp-email-server](https://github.com/ai-zerolab/mcp-email-server) (BSD-3-Clause)
- **Image**: `ghcr.io/ai-zerolab/mcp-email-server:latest`
- **Transport**: Streamable HTTP on port 9557, behind a guard that asks for a token
- **Backend**: any IMAP/SMTP server; by default `mail.${DOMAIN}`

## How it is protected

The upstream server has no authentication: whoever reaches it can read, send and delete the mail,
and attach any file the container can read, its own password file included. So the stack runs it
behind a guard (`guard/`, a small TypeScript proxy built on the server at deploy):

- **Token.** The guard refuses with 401 every request without
  `Authorization: Bearer <EMAIL_MCP_TOKEN>`. With no token, or one shorter than 32 characters, it
  answers 503 to everything, and compose refuses to start it without the key.
- **Tool allowlist, deny by default.** Only the tools in the table below exist for the caller.
  Every other tool is dropped from the tool list and refused if called, and so is any
  `attachments` argument. JSON-RPC batches, methods other than tool use, and bodies that do not
  parse are refused too.
- **Who may change mail.** Reading is open to everyone Open WebUI offers the tools to: admin
  accounts only. Sending, moving, archiving and marking mail work only for the Open WebUI accounts
  listed in `EMAIL_MCP_ALLOWED_USERS`. Open WebUI sends the signed-in user's address in the
  `X-OpenWebUI-User-Email` header, and the guard trusts it only on a request with the valid token.
- **Networks.** Open WebUI reaches the guard as `http://hl-email-mcp:9557/mcp` on the
  `hl-email-mcp` network. The upstream server is on `hl-email-mcp-upstream`, an internal network
  only the guard shares, and on `hl-email-mcp-egress`, its way out to the mail host, which no other
  container joins. Neither container is on `proxy` or publishes a port.

## Why this MCP?

This MCP exposes a self-hosted mail server to AI agents without going through Gmail/OAuth. Same pattern as
`caldav-mcp` (events/todos): a thin HTTP MCP that
wraps a self-hosted protocol server.

## Tools

The guard passes these tools of the upstream image and no other:

| Tool                      | Who may call it                | What it does                                                 |
| ------------------------- | ------------------------------ | ------------------------------------------------------------ |
| `list_available_accounts` | everyone offered the tools     | List configured accounts, credentials masked                 |
| `list_mailboxes`          | everyone offered the tools     | List IMAP folders (INBOX, Sent, Drafts, Trash, …)            |
| `list_emails_metadata`    | everyone offered the tools     | Search by sender, subject, body, date range                  |
| `get_emails_content`      | everyone offered the tools     | Read full messages (`mark_as_read` only for allowed users)   |
| `send_email`              | `EMAIL_MCP_ALLOWED_USERS` only | Send a message, also as a reply, without attachments         |
| `save_to_mailbox`         | `EMAIL_MCP_ALLOWED_USERS` only | Save a message, such as a draft, to a folder                 |
| `move_emails`             | `EMAIL_MCP_ALLOWED_USERS` only | Move messages between folders; to delete, move them to Trash |
| `archive_emails`          | `EMAIL_MCP_ALLOWED_USERS` only | Move messages to the Archive folder                          |
| `mark_emails_as_read`     | `EMAIL_MCP_ALLOWED_USERS` only | Mark messages as read                                        |

Never passed:

- `delete_emails`: it flags the message and expunges it, so the delete is permanent. Move the
  message to Trash with `move_emails` instead; the mail server's Trash is the recovery window.
- `add_email_account`: it would add an account with a mail host of the caller's choice.
- `download_attachment`: it writes into the container's filesystem.
- Any `attachments` argument: upstream attaches files from the container's filesystem, and one of
  them holds the mailbox password.
- Any tool a newer upstream image adds, until it is added to the guard's list.

## Setup

### 1. Ensure the IMAP/SMTP account exists

The account must already exist on your mail server (for Docker Mailserver:
`docker exec -it mailserver setup email add you@example.com`).

### 2. Add the variables

`rostok stack add email-mcp` asks for them and writes them to the server's
`.env`; it generates `EMAIL_MCP_TOKEN`. `before.deploy.ts` renders them into `stacks/email-mcp/config.toml`
(mode 0600), which the container mounts as `/config.toml`. Do not commit the
rendered file. The deploy stops if a required key is missing.

## Variables

| Key                        | Default           | Meaning                                                                            |
| -------------------------- | ----------------- | ---------------------------------------------------------------------------------- |
| `EMAIL_MCP_HOST`           | `mail.${DOMAIN}`  | Mail server host: IMAP on 993 (TLS), SMTP on 587 (STARTTLS)                        |
| `EMAIL_MCP_USER`           | required          | Login and address of the first account                                             |
| `EMAIL_MCP_PASSWORD`       | required, secret  | Password of the first account                                                      |
| `EMAIL_MCP_ACCOUNT_NAME`   | `main`            | Account name the assistant sees for the first account                              |
| `EMAIL_MCP_FULL_NAME`      | the address       | Display name of the first account                                                  |
| `EMAIL_MCP_USER_2`         | none              | Login and address of an optional second account                                    |
| `EMAIL_MCP_PASSWORD_2`     | none, secret      | Password of the second account (required with a user)                              |
| `EMAIL_MCP_FULL_NAME_2`    | its address       | Display name of the second account                                                 |
| `EMAIL_MCP_ACCOUNT_NAME_2` | `second`          | Account name the assistant sees for the second account                             |
| `EMAIL_MCP_TOKEN`          | generated, secret | Bearer token the guard asks for; Open WebUI sends it                               |
| `EMAIL_MCP_ALLOWED_USERS`  | none              | Open WebUI login addresses, comma-separated, that may change mail; none: read-only |
| `EMAIL_MCP_IMAGE_TAG`      | `latest`          | Image tag of `ghcr.io/ai-zerolab/mcp-email-server`                                 |

The stack has no Traefik route, so it needs no domain and no `traefik` stack.

### 3. Deploy

```bash
rostok deploy <server>
```

### 4. Wire into Open WebUI

The `open-webui` stack already lists this server among its tool servers, switched off. Set
`OPEN_WEBUI_ENABLE_EMAIL_MCP=true` in the server's `.env`, and give Open WebUI the token: write
this line by hand, without quotes and below the `EMAIL_MCP_TOKEN` line, so compose resolves the
reference and both stacks share one value:

```bash
OPEN_WEBUI_EMAIL_MCP_TOKEN=${EMAIL_MCP_TOKEN}
```

Then deploy both stacks:

```bash
rostok deploy <server>
```

Open WebUI's `after.deploy.ts` connects `hl-open-webui` to this stack's `hl-email-mcp` network.

### 5. Verify

In Open WebUI chat:

> "List my mailboxes"
> "Show me unread emails in INBOX"
> "Send an email to test@example.com with subject 'hello' and body 'world'" (needs your Open
> WebUI address in `EMAIL_MCP_ALLOWED_USERS`)

## Upgrading a server that already runs this stack

Before this version the endpoint asked for no token. To upgrade, add two keys to the server's
`.env`, with the same value, and deploy:

1. Generate a token: `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='` (any value of at
   least 32 characters works).
2. Add `EMAIL_MCP_TOKEN=<that value>`. The deploy stops and names this key while it is missing.
3. Below that line, add `OPEN_WEBUI_EMAIL_MCP_TOKEN=${EMAIL_MCP_TOKEN}` (no quotes), so Open WebUI
   sends the same value.
4. To keep sending and moving mail from the assistant, add
   `EMAIL_MCP_ALLOWED_USERS=<your Open WebUI login address>`. Without it, the tools only read.
5. `rostok deploy <server>`. The deploy replaces the old `hl-email-mcp` container with the guard
   and starts the upstream server as `hl-email-mcp-upstream`.

The e-mail tools are now offered to admin accounts only. Ordinary users of Open WebUI no longer
see them.

## The risk that remains

The guard decides which tools run and for whom; it cannot judge what the assistant asks them to
do. A received e-mail can carry instructions that talk the assistant into reading other mail, or,
for a user in `EMAIL_MCP_ALLOWED_USERS`, into sending mail, to any recipient, with what it read in
the body. Keep `EMAIL_MCP_ALLOWED_USERS` short, and read what the assistant proposes to send. The
upstream `allowed_recipients` setting would limit the recipients, but this stack does not set it.

## TLS

The connection to the mail server always verifies its certificate: IMAP on 993
(TLS) and SMTP on 587 (STARTTLS). `EMAIL_MCP_HOST` must be a name the
certificate covers, and the certificate must chain to a public authority the
container trusts (Let's Encrypt works). There is no setting to turn the check
off: without it, anyone on the path to the mail server could read the password
and the mail.

**Upgrading a server deployed before this check was enforced.** Older versions
wrote `EMAIL_MCP_VERIFY_SSL=false` to the server's `.env` and did not verify.
That key is now ignored; delete the line. Before the next deploy, check that
the mail host presents a valid certificate for its name:

```bash
EMAIL_MCP_HOST=mail.example.com # the value from the server's .env
openssl s_client -connect "$EMAIL_MCP_HOST:993" \
  -verify_return_error -verify_hostname "$EMAIL_MCP_HOST" </dev/null
openssl s_client -connect "$EMAIL_MCP_HOST:587" -starttls smtp \
  -verify_return_error -verify_hostname "$EMAIL_MCP_HOST" </dev/null
```

Both must exit with status 0 and print `Verification: OK`. Without
`-verify_hostname` the command checks only the chain, and passes for a
certificate issued to another name. If one fails, every mail tool fails with
`CERTIFICATE_VERIFY_FAILED` after the deploy: give the mail host a certificate
for that name, or point `EMAIL_MCP_HOST` at the name its certificate covers. A
self-signed certificate, or one from a private authority, fails too.

## Attachment downloads

Off. `before.deploy.ts` writes `enable_attachment_download = false` into
`config.toml` on every deploy, and no key of the `.env` turns it on, so the
assistant cannot save received attachments inside the container.

## Second account

Set `EMAIL_MCP_USER_2` and `EMAIL_MCP_PASSWORD_2`; both accounts use the same
host and port settings. For more than two, extend `renderConfig` in
`before.deploy.ts` (mcp-email-server reads several `[[emails]]` blocks only
from the TOML file, not from env vars).

## Security notes

- The guard is described under "How it is protected" above. It runs as a non-root user with a
  read-only filesystem, no capabilities, `no-new-privileges:true` and a 128M memory limit. Deno
  lets it listen on 9557, reach only `hl-email-mcp-upstream:9557`, and read only its two keys.
- The upstream container has `no-new-privileges:true` and a 256M memory limit. Its DNS rebinding
  protection allows only the host name the guard calls it by, and localhost.
- No Traefik labels on either container.
- The MCP holds your plaintext password in env. Rotate via
  `setup email update` on the mailserver if leaked.

## Troubleshooting

| Symptom                                       | Cause                                    | Fix                                                               |
| --------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------- |
| `535 Authentication failed`                   | Wrong password or missing account        | `setup email update you@example.com`                              |
| `Connection refused` on port 993/587          | Firewall blocks home → cloud             | Check cloud security group                                        |
| `CERTIFICATE_VERIFY_FAILED`                   | Certificate not valid for the host       | See "TLS" above; also check the server clock with `date`          |
| Tools not showing in Open WebUI               | Switch off, or not on the network        | `OPEN_WEBUI_ENABLE_EMAIL_MCP=true`, then `rostok deploy <server>` |
| Tools not showing for a user                  | The tools are for admins only            | Make the account an admin, or use an admin account                |
| 401 from the guard                            | Open WebUI sends no or another token     | `OPEN_WEBUI_EMAIL_MCP_TOKEN=${EMAIL_MCP_TOKEN}` below that line   |
| 503 from the guard                            | `EMAIL_MCP_TOKEN` empty or too short     | A value of at least 32 characters, then deploy                    |
| "changes mail and this user may only read it" | Account not in `EMAIL_MCP_ALLOWED_USERS` | Add its Open WebUI login address, then deploy                     |
| 403 from MCP                                  | DNS rebinding protection blocks origin   | Add host to `MCP_ALLOWED_HOSTS` / origin to `MCP_ALLOWED_ORIGINS` |
