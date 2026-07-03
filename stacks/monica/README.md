# Monica

Personal CRM — manage relationships with friends, family, and contacts.

## Features

- Contact management with rich profiles
- Activity logging and reminders
- Gift tracking
- Relationship mapping
- Journal and notes
- Multi-user with permissions

## Access

Web UI: `https://crm.${DOMAIN}` (protected by Authelia SSO)

## Configuration

```bash
APP_URL=https://crm.${DOMAIN}
DB_CONNECTION=mysql
DB_HOST=monica-db
```

## Backup

MariaDB dump + storage data backed up nightly via Restic.

## Resources

- [Monica Documentation](https://docs.monicahq.com/)
- [Monica GitHub](https://github.com/monicahq/monica)
