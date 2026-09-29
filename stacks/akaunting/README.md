# Akaunting

Self-hosted accounting and invoicing software.

## Features

- Invoicing with automatic numbering
- Expense tracking
- Bank account reconciliation
- Financial reports (P&L, balance sheet)
- Multi-currency support
- Customer management

## Access

Web UI: `https://invoices.${DOMAIN}` (protected by Authelia SSO)

## Configuration

```bash
APP_URL=https://invoices.${DOMAIN}
DB_CONNECTION=mysql
DB_HOST=akaunting-db
DB_DATABASE=akaunting
```

## Backup

PostgreSQL dump + storage data backed up nightly via Restic.

## Resources

- [Akaunting Documentation](https://akaunting.com/docs)
- [Akaunting GitHub](https://github.com/akaunting/akaunting)

## Variables

Declared in `+meta.ts`. Requires the `traefik` stack.

| Key                          | Default           | Meaning                             |
| ---------------------------- | ----------------- | ----------------------------------- |
| `AKAUNTING_DB_ROOT_PASSWORD` | generated, secret | MariaDB root password               |
| `AKAUNTING_DB_PASSWORD`      | generated, secret | Password of the `akaunting` DB user |
