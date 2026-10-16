# Umami

Privacy-first web analytics — lightweight alternative to Google Analytics.

## Features

- Cookie-free tracking
- Pageviews, events, and session data
- Real-time dashboard
- Team collaboration with user management
- Shareable analytics links
- Proxy path (`/umami/`) for ad-blocker evasion

## Access

Web UI: `https://<UMAMI_DOMAIN>`

## Configuration

| Variable                 | Default           | Meaning                                      |
| ------------------------ | ----------------- | -------------------------------------------- |
| `UMAMI_IMAGE_TAG`        | `latest`          | Image tag                                    |
| `UMAMI_DB_IMAGE_TAG`     | `16-alpine`       | Image tag of `postgres` (service `umami-db`) |
| `UMAMI_DOMAIN`           | `stats.${DOMAIN}` | Dashboard host                               |
| `UMAMI_PROXY_DOMAIN`     | `${DOMAIN}`       | Site host that proxies `/umami/` to Umami    |
| `UMAMI_PROXY_WWW_DOMAIN` | `www.${DOMAIN}`   | The www host of that site                    |
| `UMAMI_DB_PASSWORD`      | generated         | PostgreSQL password                          |
| `UMAMI_APP_SECRET`       | generated         | Umami session secret                         |

The `/umami/` path lets the tracking script load from the tracked site's own domain, which ad
blockers and Safari tracking prevention leave alone. It applies only to sites that this server's
Traefik serves. Point the two proxy variables at another host if your site is not on the apex
domain.

## Database network

The database (`hl-umami-db`) sits on a network of its own, `umami-db`, which only Umami joins. It
is not on the `proxy` network, so no other stack can open its port, and it has no route to the
outside. A deploy of this version moves an existing install over by itself: both containers are
recreated, the data stays.

### Existing installs: check for a `trust` rule

A database that was first started without a password accepts every connection without one, and
setting `UMAMI_DB_PASSWORD` later does not change that. Check the last line of its access rules on
the server:

```sh
docker exec hl-umami-db tail -n 1 /var/lib/postgresql/data/pg_hba.conf
```

`host all all all scram-sha-256` is fine. If it says `host all all all trust`, close it:

1. Make sure `UMAMI_DB_PASSWORD` is set in the server's `.env` and deployed. This prints the
   password's length plus one, never the password; `1` means it is empty, so stop and set it first.

   ```sh
   docker exec hl-umami-db printenv POSTGRES_PASSWORD | wc -c
   ```

2. Set that password inside the database:

   ```sh
   docker exec -i hl-umami-db psql -U umami -d umami <<'SQL'
   \getenv pw POSTGRES_PASSWORD
   ALTER USER umami PASSWORD :'pw';
   SQL
   ```

3. Switch the rule to ask for the password, and reload:

   ```sh
   docker exec -u postgres hl-umami-db sed -i '$ s/trust$/scram-sha-256/' /var/lib/postgresql/data/pg_hba.conf
   docker exec hl-umami-db psql -U umami -d umami -c 'SELECT pg_reload_conf()'
   ```

Run the check again, then open the dashboard: Umami signs in to the database with the same
password, so it keeps working.

## Script Integration

```html
<script defer src="https://<UMAMI_DOMAIN>/script.js" data-website-id="YOUR-ID"></script>
```

## Resources

- [Umami Website](https://umami.is/)
- [Umami GitHub](https://github.com/umami-software/umami)
