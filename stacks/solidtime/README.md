# solidtime

Open-source time tracker: projects, clients, tasks, billable rates, reports with PDF export, and a
desktop app. [solidtime.io](https://www.solidtime.io)

It has its own accounts, and the desktop app and the API sign in against it, so no Authelia sits in
front of it.

## Containers

| Container                | What it does                                                        |
| ------------------------ | ------------------------------------------------------------------- |
| `hl-solidtime`           | Web app and API on `SOLIDTIME_DOMAIN`; runs the migrations on start |
| `hl-solidtime-scheduler` | Scheduled jobs (reminder mails, clean-up)                           |
| `hl-solidtime-queue`     | Queue worker (mails, exports)                                       |
| `hl-solidtime-db`        | PostgreSQL 18                                                       |
| `hl-solidtime-gotenberg` | Turns reports into PDFs                                             |

Only `hl-solidtime` joins the `proxy` network. The database and Gotenberg sit on an internal
network with no route out. Gotenberg therefore cannot load the report's web font, and PDFs use the
fallback font.

## Configuration

| Variable                        | Default             | Meaning                                                 |
| ------------------------------- | ------------------- | ------------------------------------------------------- |
| `SOLIDTIME_IMAGE_TAG`           | `latest`            | Tag of `solidtime/solidtime` (web, scheduler and queue) |
| `SOLIDTIME_DB_IMAGE_TAG`        | `18-alpine`         | Tag of `postgres`                                       |
| `SOLIDTIME_GOTENBERG_IMAGE_TAG` | `8`                 | Tag of `gotenberg/gotenberg`                            |
| `SOLIDTIME_DOMAIN`              | `time.${DOMAIN}`    | Public host                                             |
| `SOLIDTIME_DB_PASSWORD`         | generated           | PostgreSQL password                                     |
| `SOLIDTIME_APP_KEY`             | generated           | Laravel encryption key (`base64:...`); never change it  |
| `SOLIDTIME_SUPER_ADMINS`        | empty               | Comma-separated e-mails that may open `/admin`          |
| `SOLIDTIME_MAIL_MAILER`         | `log`               | `log` writes mails to the container log; `smtp` sends   |
| `SOLIDTIME_MAIL_HOST`           | empty               | SMTP host                                               |
| `SOLIDTIME_MAIL_PORT`           | `587`               | SMTP port                                               |
| `SOLIDTIME_MAIL_ENCRYPTION`     | `tls`               | `tls` (STARTTLS) or `ssl`                               |
| `SOLIDTIME_MAIL_USERNAME`       | empty               | SMTP username                                           |
| `SOLIDTIME_MAIL_PASSWORD`       | empty               | SMTP password                                           |
| `SOLIDTIME_MAIL_FROM_ADDRESS`   | `noreply@${DOMAIN}` | Sender address                                          |

The three solidtime containers share their settings through the `x-solidtime-environment` block
at the top of `compose.yml`.

The OAuth key pair that signs the desktop app's and the API's tokens has no variable: on its first
start the web container runs `php artisan passport:keys`, which writes
`${VOLUMES_PATH}/solidtime/storage/oauth-private.key` and `oauth-public.key`. Later starts keep
them.

## Sign-up is off

`APP_ENABLE_REGISTRATION=off` in `compose.yml`: the sign-up page still opens, but solidtime refuses
every sign-up with "Registration is disabled.", so the address can be public. Create each account
on the server:

```sh
docker exec -it hl-solidtime php artisan admin:user:create "Your Name" you@example.com --verify-email
```

It prints a random password; add `--ask-for-password` to type your own instead. To let a person
open the admin panel at `/admin`, add their e-mail to `SOLIDTIME_SUPER_ADMINS` and deploy.

## Desktop app

Register the desktop app once, then enter the client ID it prints and `https://<SOLIDTIME_DOMAIN>`
under "Instance Settings" in the app:

```sh
docker exec hl-solidtime php artisan passport:client --name=desktop --redirect_uri=solidtime://oauth/callback --public -n
```

API tokens for users need a personal access client, also once:

```sh
docker exec hl-solidtime php artisan passport:client --personal --name=API -n
```

## No reports to the vendor

The scheduler's daily usage report and update check, both sent to app.solidtime.io, are off
(`SCHEDULING_TASK_SELF_HOSTING_TELEMETRY=false`,
`SCHEDULING_TASK_SELF_HOSTING_CHECK_FOR_UPDATE=false` in `compose.yml`).

## Backup

`backup.ts` stops the stack and backs up `${VOLUMES_PATH}/solidtime`: the database in `postgres/`
and `storage/`, which holds uploads and the OAuth key pair. Without the key pair, a restored server
signs out the desktop app and every API token stops working.

## Resources

- [Self-hosting docs](https://docs.solidtime.io/self-hosting/intro)
- [solidtime on GitHub](https://github.com/solidtime-io/solidtime)
