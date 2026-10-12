# Authelia

Single sign-on portal for the services behind Traefik: one sign-in page at `auth.${DOMAIN}`, and
any router that names the `authelia@file` middleware asks it who the visitor is. A Redis
container beside it keeps the sessions.

`rostok stack add authelia` followed by a deploy gives a working sign-in page with one user. The
deploy writes Authelia's two config files for you; a server that keeps its own gets its own.

## Settings

| Key                                                      | Default           | What it is                                                             |
| -------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------- |
| `AUTHELIA_DOMAIN`                                        | `auth.${DOMAIN}`  | Host of the sign-in page. Must be `DOMAIN` itself or below it.         |
| `AUTHELIA_SESSION_SECRET`                                | generated, secret | Protects the session data in Redis.                                    |
| `AUTHELIA_STORAGE_ENCRYPTION_KEY`                        | generated, secret | Encrypts the database. Never change it by hand, see "Existing server". |
| `AUTHELIA_IDENTITY_VALIDATION_RESET_PASSWORD_JWT_SECRET` | generated, secret | Signs password reset links.                                            |
| `AUTHELIA_ADMIN_USER`                                    | `admin`           | Name of the first user.                                                |
| `AUTHELIA_ADMIN_EMAIL`                                   | `admin@${DOMAIN}` | Email address of the first user.                                       |
| `AUTHELIA_ADMIN_PASSWORD`                                | generated, secret | Password of the first user. Read it from `servers/<server>/.env`.      |
| `AUTHELIA_SMTP_ADDRESS`                                  | none              | Mail server, for example `submission://smtp.example.com:587`.          |
| `AUTHELIA_SMTP_SENDER`                                   | none              | Sender, for example `Authelia <auth@example.com>`.                     |
| `AUTHELIA_SMTP_USERNAME`                                 | none              | SMTP user name.                                                        |
| `AUTHELIA_SMTP_PASSWORD`                                 | none, secret      | SMTP password.                                                         |

The three secrets reach Authelia as environment variables of the same names, and the deploy stops
when one is missing. They are never written into `configuration.yml`: Authelia does not expand
`${...}` in that file, so a placeholder there would itself become the secret.

## What a deploy generates

`before.deploy.ts` writes two files, which `compose.yml` mounts from
`${PATH_APPS}/configs/authelia/`:

- `configuration.yml`: the session cookie for `DOMAIN`, the sign-in page at `AUTHELIA_DOMAIN`,
  Redis sessions, users from `users.yml`, an SQLite database in the data folder, and the
  password asked for every protected host (`one_factor`). It holds no secret.
- `users.yml`: one user, `AUTHELIA_ADMIN_USER`, in the group `admins`. It holds a
  PBKDF2-SHA512 hash of `AUTHELIA_ADMIN_PASSWORD`, never the password. The deploy log shows
  neither.

Both files are written again on every deploy, with the same content for the same settings. To
change the first user's password, change `AUTHELIA_ADMIN_PASSWORD` in `.env` and deploy.

A deploy after a change to either file recreates the Authelia container, so the change takes
effect at once; a deploy with no change leaves the container running. The hook does this with a
label on the container (`rostok.authelia.config-hash`) that holds a hash of the two files. It is
needed because each file is mounted on its own: without it, the container would keep the old
file until someone restarted it.

### Password reset and mail

Without `AUTHELIA_SMTP_ADDRESS` and `AUTHELIA_SMTP_SENDER`, password reset is switched off.
Authelia would otherwise write the reset link into a file on the server
(`${VOLUMES_PATH}/authelia/data/notifications.yml`), which is no use to the person who forgot the
password. One-time codes, such as the one for registering a second factor, go to that file.

With both set, Authelia sends mail through that server and password reset is on. Set both or
neither. The SMTP password is passed to Authelia as an environment variable, not written to
`configuration.yml`.

## The server's own files win

Keep your own file in the project and the deploy uses it instead of generating one:

```
servers/<server>/configs/authelia/configuration.yml
servers/<server>/configs/authelia/users.yml
```

Each of the two is checked on its own, so you can keep your own `users.yml` and let the deploy
generate `configuration.yml`, or the other way round. A per-server hook,
`servers/<server>/configs/authelia/before.deploy.ts`, may also write either file into
`configs/authelia/` of its working directory, for example from an encrypted source. It runs
after the stack's hook, and what it writes replaces the generated file before anything is
copied to the server.

A file written by a per-server hook is the one case where a change does not restart Authelia by
itself: the hash is taken before that hook runs. Either list the file for the stack in
`servers/<server>/config.json`, so the deploy restarts the stack when the file on the server
changed:

```json
{ "name": "authelia", "watchFilesAndRestartIfChanged": ["configs/authelia/users.yml"] }
```

or restart the container on the server after such a deploy: `docker restart hl-authelia`. A
plain file in `servers/<server>/configs/authelia/` needs neither.

Three rules for your own `configuration.yml`:

- Do not set `session.secret`, `storage.encryption_key` or
  `identity_validation.reset_password.jwt_secret` in it. The environment variables win anyway.
- Do not put an SMTP password in it. Set `AUTHELIA_SMTP_PASSWORD` in `.env`; the deploy hands it
  to Authelia whatever your file says about mail.
- Keep the paths `compose.yml` mounts: `/config/users.yml` for the users and `/data` for the
  database, and `authelia-redis` as the Redis host.

## Adding users

The generated `users.yml` has one user. For more, keep your own
`servers/<server>/configs/authelia/users.yml`:

```yaml
users:
  alice:
    displayname: "Alice"
    password: "$argon2id$..."
    email: alice@example.com
    groups:
      - admins
```

Make the hash with Authelia itself, on any machine with Docker:

```bash
docker run --rm -it authelia/authelia:latest authelia crypto hash generate argon2
```

Then deploy. Do not commit a real `users.yml` in plain text to a public repository.

## Protecting a service

A router asks Authelia by naming the middleware:

```yaml
- "traefik.http.routers.hl-myservice.middlewares=authelia@file"
```

The stack does not define that middleware. Add it to a Traefik dynamic file of the server, as a
`forwardAuth` to `http://hl-authelia:9091/api/authz/forward-auth`.

## Existing server

For a server that already runs Authelia with its own config files, before the first deploy from
this version:

1. Put the three secrets into `servers/<server>/.env`, with the values Authelia uses today:

   ```
   AUTHELIA_SESSION_SECRET=...
   AUTHELIA_STORAGE_ENCRYPTION_KEY=...
   AUTHELIA_IDENTITY_VALIDATION_RESET_PASSWORD_JWT_SECRET=...
   ```

   `AUTHELIA_STORAGE_ENCRYPTION_KEY` must be the key the existing database is encrypted with.
   With any other key Authelia refuses to start; it does not damage the database. The key in
   use is the `storage.encryption_key` of the current `configuration.yml` exactly as written
   there, or the container's `AUTHELIA_STORAGE_ENCRYPTION_KEY` if it has one. If the file holds
   a `${...}` placeholder, that text is the key. Check a candidate on the server before
   deploying:

   ```bash
   docker exec -e AUTHELIA_STORAGE_ENCRYPTION_KEY='<candidate>' hl-authelia \
     authelia storage encryption check --config /config/configuration.yml
   ```

   It prints `Storage Encryption Key Validation: SUCCESS` for the right key. To move the
   database to a new key, use `authelia storage encryption change-key` first, then put the new
   key into `.env`.

   Put a value that contains `$` in single quotes, for example
   `AUTHELIA_STORAGE_ENCRYPTION_KEY='${...}'` for a placeholder that became the key. Without
   the quotes compose reads it as a reference to another variable, the value comes out empty,
   and the deploy stops with "required variable AUTHELIA_STORAGE_ENCRYPTION_KEY is missing a
   value".

   The session secret and the reset-password secret may be new values: sessions end and
   pending reset links stop working, nothing else.

2. Run `rostok stack add authelia -s <server>`. It keeps every value already in `.env`, so do
   step 1 first: a key that is missing then is generated, and a generated storage key does not
   open the existing database. It also adds `AUTHELIA_ADMIN_PASSWORD`, which is only used when
   the deploy generates `users.yml`.

3. Keep your `configuration.yml` and `users.yml` in `servers/<server>/configs/authelia/` as
   before, and follow the three rules above. If your file sends mail, move its SMTP password to
   `AUTHELIA_SMTP_PASSWORD` in `.env`.

4. Run `rostok env encrypt`, then deploy.

The container names, the networks, the Traefik labels and the data folder
(`${VOLUMES_PATH}/authelia/data`) are unchanged.

## Resources

- [Authelia documentation](https://www.authelia.com/)
