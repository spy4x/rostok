# caldav-tasks-web

Web client for the tasks on a CalDAV server. One owner, one CalDAV account, no database.

**Upstream:** <https://github.com/spy4x/caldav-tasks-web>

## What it does

The owner signs in with a password and sees the task lists of one CalDAV account (for example
the Stalwart in this catalog): list, create, edit, complete and delete tasks. The server only
relays requests to the CalDAV server, so any other CalDAV client (Tasks.org, for one) sees every
change. With the push settings below, a reminder set on a task notifies the browsers the owner
turned notifications on in, also while the app is closed. The only thing the server stores is the
list of those browsers and which reminders of the last hour it already sent (task id and time,
no task text).

## Access

- App: `https://todos.${DOMAIN}`
- Health (Gatus): `https://todos.${DOMAIN}/health` answers 200 with `{"status":"ok"}`.

## Configuration

`rostok stack add caldav-tasks-web` writes these to `.env`:

| Variable                       | Default                                                   | Description                                  |
| ------------------------------ | --------------------------------------------------------- | -------------------------------------------- |
| `CALDAV_TASKS_WEB_DOMAIN`      | `todos.${DOMAIN}`                                         | Public host of the app.                      |
| `CALDAV_TASKS_WEB_IMAGE_TAG`   | `latest`                                                  | Image tag; pin it to roll back.              |
| `CALDAV_TASKS_WEB_MIDDLEWARES` | `security-headers@file,compression@file,robots-deny@file` | Traefik middleware chain for the whole host. |

The stack does not start until `servers/<server>/configs/caldav-tasks-web.env` exists: write it
before the first deploy. It holds the app's own settings, as env vars in
`${PATH_APPS}/configs/caldav-tasks-web.env`. It holds secrets, so `rostok env encrypt` encrypts it to
`configs/caldav-tasks-web.env.age`, which is safe to commit; `rostok env decrypt` writes the
plaintext file back in a fresh clone. Run `rostok env encrypt` after every edit. These seven are
required; the app refuses to start without any of them:

| Variable              | Meaning                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `PUBLIC_URL`          | The address people open the app at; must match `CALDAV_TASKS_WEB_DOMAIN`.                 |
| `CALDAV_URL`          | The CalDAV server's public address. Credentials are sent to this origin only.             |
| `CALDAV_USERNAME`     | The CalDAV account the app uses.                                                          |
| `CALDAV_PASSWORD`     | That account's password.                                                                  |
| `OWNER_PASSWORD_HASH` | The owner's sign-in password, hashed (`deno task password:hash` in the app's repository). |
| `AUTH_PEPPER`         | Key for the password hasher; at least 32 characters (`openssl rand -base64 32`).          |
| `SESSION_SECRET`      | Signs the session cookie; at least 32 characters. Changing it signs everyone out.         |

Reminder notifications are optional and need five more, all or none. With none the app runs
without notifications; with only some it refuses to start and names the missing ones:

| Variable             | Meaning                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `VAPID_PUBLIC_KEY`   | The public half of the Web Push key pair (`deno task vapid:keys mailto:you@example.com --print` in the app's repo). |
| `VAPID_PRIVATE_KEY`  | The private half. Changing the pair makes every browser subscribe again the next time it opens.                     |
| `VAPID_SUBJECT`      | A contact for the push services: a `mailto:` or `https:` address.                                                   |
| `DATA_DIR`           | `/data`, the folder the volume is mounted at. The image allows writing nowhere else.                                |
| `REMINDER_TIME_ZONE` | An IANA zone, such as `Europe/Berlin`, for reminders on tasks with a date and no time.                              |

The container must reach the browsers' push services over HTTPS (Google, Mozilla, Apple).

See <https://github.com/spy4x/caldav-tasks-web/blob/main/.env.example> for the syntax.

## Resources

- Memory limit: 128M
- CPU limit: 0.5

## Backup

Tasks live on the CalDAV server, which has its own backup. The one file the app writes,
`${VOLUMES_PATH}/caldav-tasks-web/push.json`, lists the browsers subscribed to notifications and the
reminders sent in the last hour. `backup.ts` copies it every night without stopping the container.
If it is lost anyway, each browser saves itself again the next time the app is opened in it; until
then that browser gets no reminders.

## Upgrading / rollback

The image is `antonshubin/caldav-tasks-web`, published by the app's CI to Docker Hub on every
`v*` tag; a stable tag (`v1.2.3`) also moves `latest`, a pre-release tag (`v1.2.3-rc.1`) never
does. Deploying always pulls the configured tag (`pull_policy: always`), and Watchtower pulls
`latest` daily on its own, so a stable release goes live within a day with no human step.

- **Deploy right away**: `deno task deploy <server> caldav-tasks-web`.
- **Pin or roll back**: set `CALDAV_TASKS_WEB_IMAGE_TAG=v1.0.0` in the server's `.env`, run
  `deno task env:encrypt`, then deploy. Watchtower leaves a pinned tag alone.

## Maintenance

- **Rotate the CalDAV password**: change it on the CalDAV server, edit `caldav-tasks-web.env`,
  run `rostok env encrypt` to refresh `caldav-tasks-web.env.age`, then redeploy.
- **Rotate `SESSION_SECRET`**: same steps; it signs the owner out.
