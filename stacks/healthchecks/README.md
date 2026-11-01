# Healthchecks

Cron job monitoring with alerts for missed tasks.

## Features

- Monitor scheduled tasks
- HTTP ping endpoint
- Email/webhook alerts
- Grace period configuration
- Status page

## Configuration

| Variable                     | Default                  | Meaning                        |
| ---------------------------- | ------------------------ | ------------------------------ |
| `HEALTHCHECKS_IMAGE_TAG`     | `latest`                 | Image tag, v5.0 or later       |
| `HEALTHCHECKS_DOMAIN`        | `healthchecks.${DOMAIN}` | Public host                    |
| `HEALTHCHECKS_SECRET_KEY`    | generated                | Django secret key              |
| `HEALTHCHECKS_SMTP_HOST`     | none                     | SMTP server (login and alerts) |
| `HEALTHCHECKS_SMTP_PORT`     | `587`                    | SMTP port, STARTTLS            |
| `HEALTHCHECKS_SMTP_USERNAME` | none                     | SMTP user                      |
| `HEALTHCHECKS_SMTP_PASSWORD` | none                     | SMTP password                  |
| `HEALTHCHECKS_SMTP_FROM`     | none                     | From address of emails         |

Healthchecks signs people in with an emailed link and registration is closed, so without SMTP
nobody can log in. Either set the SMTP variables, or create the first user by hand:

```bash
docker exec -it hl-healthchecks /opt/healthchecks/manage.py createsuperuser
```

### Upgrading an older install

Deploy creates `${VOLUMES_PATH}/healthchecks` owned by `999:999`, the container's user, but only
when the folder is new. A folder created by an older release keeps its old owner, and Healthchecks
cannot write its database. Fix it once on the server:

```bash
sudo chown -R 999:999 <VOLUMES_PATH>/healthchecks
```

## Access

Web UI: `https://<HEALTHCHECKS_DOMAIN>`

## Usage

Create check in UI, then ping endpoint from cron job:

```bash
# In crontab
0 2 * * * /path/to/backup.sh && curl -fsS -m 10 --retry 5 https://healthchecks.example.com/ping/YOUR-UUID
```

Alert fires if ping not received within expected interval.

## Resources

- [Healthchecks Documentation](https://healthchecks.io/docs/)
