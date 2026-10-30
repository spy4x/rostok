# Upgrading Postgres 16 to 18

The `gitea`, `umami` and `caldiy` stacks run Postgres 18. Up to rostok 1.21 they ran Postgres 16,
with its data in `${VOLUMES_PATH}/<stack>/db`. A Postgres 18 server cannot read that data, and
the Postgres 18 image keeps its data in another place, so the stacks now use a new folder:
`${VOLUMES_PATH}/<stack>/postgres`.

A new install needs nothing from this page. An existing install moves its data once, with
`scripts/postgres-upgrade/upgrade.sh`. Until it has, `rostok deploy` stops before it changes
anything on the server and prints:

```
gitea: /srv/volumes/gitea/db holds data from Postgres 16 or older, and /srv/volumes/gitea/postgres holds none.
This version runs Postgres 18 in /srv/volumes/gitea/postgres and would start with an empty database.
```

Without that check, Postgres 18 would start on the empty new folder and the app would look as if
all its data were gone.

## Which app versions support Postgres 18

| Stack    | Needs                        | Source                                                                                                                                                                            |
| -------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gitea`  | Gitea 28.0.0 or later        | [Gitea docs: PostgreSQL >= 12](https://docs.gitea.com/installation/database-prep); a Postgres 18 bug fixed in 28.0.0: [go-gitea/gitea#37952](https://github.com/go-gitea/gitea/issues/37952) |
| `umami`  | any current Umami            | [Umami docs: PostgreSQL 12.14 or later](https://docs.umami.is/docs/install); maintainers on 18: [umami-software/umami#4509](https://github.com/umami-software/umami/issues/4509)       |
| `caldiy` | any Cal.diy from 2025-10-29 on | Cal.diy's own `docker-compose.yml` runs `postgres` 18 with this layout since [calcom/cal.diy@ee00f0d](https://github.com/calcom/cal.diy/commit/ee00f0d52c94cbda04757c841a21aa2f68dccb03) |

The default image tag `latest` of each app is new enough. If you pinned `GITEA_IMAGE_TAG` to a
version before 28.0.0, update it first.

## Upgrade an existing install

Do this once per stack, on the server, while the old version of the stack still runs (you have not
deployed the new rostok yet, or the deploy stopped with the message above).

1. Take a backup the way your server's backup cron line does (see
   [Disaster recovery](disaster-recovery.md)). The script keeps two more copies, but a backup off
   the server is the one that survives a lost disk.
2. Get the script. Use your rostok version's tag in place of `main` to get the matching copy:

   ```sh
   curl -fsSLO https://raw.githubusercontent.com/spy4x/rostok/main/scripts/postgres-upgrade/upgrade.sh
   ```

3. Run it as root, with your `VOLUMES_PATH` and the stack name:

   ```sh
   sudo sh upgrade.sh /srv/volumes gitea
   ```

4. From your rostok project, update the CLI and deploy: `rostok deploy`. The deploy starts
   Postgres 18 on the new folder and starts the app again.
5. Open the app and check your data is there.
6. Once it is, delete what the script kept: `${VOLUMES_PATH}/<stack>/db-pg16-<date>` (the old data
   folder) and `${VOLUMES_PATH}/<stack>/pg16-<date>.sql` (the dump). Your backups include them
   until you do.

## What the script does

1. Checks that `hl-<stack>-db` runs Postgres 17 or older on `${VOLUMES_PATH}/<stack>/db`, and that
   `${VOLUMES_PATH}/<stack>/postgres` is missing or empty.
2. Stops the stack's other containers, so nothing writes during the move, and counts the rows of
   every table.
3. Dumps every database with `pg_dumpall` to `${VOLUMES_PATH}/<stack>/pg16-<date>.sql`.
4. Stops the database and renames `db` to `db-pg16-<date>`. Nothing in it is changed or deleted.
5. Starts a temporary `postgres:18-alpine` container, with the same user, password and database
   name as the old one and no network, on the new folder, and restores the dump into it.
6. Fails if the restore reported an error other than "role/database already exists" (the new
   server makes both from the same settings), or if any table's row count differs.
7. Stops the temporary container. The app stays stopped until `rostok deploy`.

If any step fails, the script puts everything back: it renames `db-pg16-<date>` back to `db`,
moves a non-empty new folder aside as `postgres-failed-<date>`, and starts the old containers
again. Running it again after a success prints "already upgraded" and changes nothing.

Set `PG_UPGRADE_IMAGE` to use another Postgres 18 image, for example a pinned
`postgres:18.1-alpine`.
