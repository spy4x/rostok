# Monitoring

How the catalog's monitoring stacks fit together, what each one watches, how to add a check for a
stack you deploy, and where alerts go. Each stack's README has its own settings; this page links to
them rather than repeating them.

## What each stack watches

| Stack                                                               | Watches                                                       | Tells you through                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------- |
| [gatus](../../stacks/gatus/README.md)                               | URLs you list: status code, response time, body               | its status page, and ntfy alerts               |
| [zond](../../stacks/zond/README.md)                                 | containers on the `proxy` network that have no public URL     | an HTTP answer (200 or 503) that gatus checks  |
| [oko](../../stacks/oko/README.md)                                   | nothing itself: shows gatus's results as one page of services | its dashboard                                  |
| [victoria-metrics](../../stacks/victoria-metrics/README.md)         | host and container metrics, and every container's log         | nothing: no UI and no alert rules in the stack |
| [ntfy](../../stacks/ntfy/README.md)                                 | nothing: it delivers the alerts the others send               | phone and desktop push                         |
| [watchtower](../../stacks/watchtower/README.md)                     | new versions of the images your containers run, once a day    | nothing: no notifications are configured       |
| [healthchecks](../../stacks/healthchecks/README.md)                 | jobs that must ping it on time, such as the backup runner     | its own e-mail alerts                          |
| backup runner ([`scripts/backup/`](../../scripts/backup/README.md)) | each night's backup of every stack                            | ntfy on failure, and a healthchecks ping       |

The usual chain is:

```
your stacks ──HTTPS──► gatus ──alert──► ntfy ──push──► your phone
     ▲                   ▲  ▲
     │ container name    │  └── oko reads gatus's badges and draws the dashboard
     └────── zond ◄──────┘
backup runner ──failure──► ntfy
              ──every run──► healthchecks (alerts when the ping is late or failed)
```

## Gatus: the checks

Gatus starts with a starter config that checks only itself. Your checks go in
`servers/<server>/configs/gatus.yml` in your rostok project; `rostok deploy` copies that file
over the starter. The gatus README shows the file's shape and the ntfy alert block.

A gatus on a server cannot tell you that the same server is down. Run gatus on two servers and let
each one check the other (gatus README, "Cross-Server Monitoring").

The status page is public: its router has no login middleware. If the names of your checks are
private, add the `authelia@file` middleware or basic auth to its router (see the
[security matrix](security-matrix.md)).

## Add a check for a stack you deploy

1. **The stack has a public URL** (most stacks: their router is in the
   [security matrix](security-matrix.md)). Add an endpoint to `configs/gatus.yml`:

   ```yaml
   endpoints:
     - name: notes
       url: "https://notes.example.com"
       interval: 5m
       conditions:
         - "[STATUS] == 200"
       alerts:
         - type: ntfy
   ```

   A route behind Traefik basic auth needs the `Authorization` header from
   `GATUS_BASIC_AUTH_BASE64` (gatus README). A route behind Authelia answers gatus with Authelia's
   redirect or refusal, not with the app, so probe that app through zond instead.

2. **The stack has no public URL, or sits behind Authelia.** Add a target to
   `servers/<server>/configs/zond.yaml`, using the container's name on the `proxy` network:

   ```yaml
   targets:
     - name: ollama
       url: http://hl-ollama:11434/
   ```

   Then point a gatus check at `https://<ZOND_DOMAIN>/health/ollama` with
   `[STATUS] == 200`. Zond reaches only containers on the `proxy` network; the
   [security matrix](security-matrix.md) says which stacks are on it.

3. **Show it on the dashboard.** Oko reads the gatus hosts in `OKO_UPTIME_HOSTS` and the service
   list in `servers/<server>/configs/oko/config.json`, which you write (oko README, "Variables").

4. Run `rostok deploy <server>`. The gatus stack restarts gatus after the deploy, so it reads the
   new file. The zond stack has no such step: after changing its targets, run
   `docker restart hl-zond` on the server.

## Metrics and logs

The victoria-metrics stack keeps 14 days of host metrics (node-exporter), container metrics
(cAdvisor) and container logs (promtail into VictoriaLogs). It has no web UI, no Traefik route and
no alert rules, and its stores take no password, so they sit on internal networks only. To read
them, connect one dashboard container to the store's network yourself; anything on that network
reads all the data, logs included. To scrape a target in another stack, connect `hl-vmagent` to
that stack's network. Both steps are in the victoria-metrics README.

## Image updates

Watchtower checks once a day for newer images under the tags your containers run, replaces the
containers that have one, and deletes the old images. It sends no notification, so the first sign
of a bad update is a gatus alert. To keep a container on its current image, give it the label
`com.centurylinklabs.watchtower.enable=false` (watchtower README). Under `IMAGE_POLICY=pinned`, a
tag is an exact version, so watchtower has nothing newer to pull until you move the pin with
`rostok images update` ([commands](../commands.md)).

## Backups

The backup runner (`scripts/backup/+main.ts`, run from cron on the server) reports in two ways,
both read from the env file its cron line passes:

- **ntfy, on failure only.** `NTFY_URL_BACKUPS` is the full topic URL (for example
  `https://ntfy.example.com/backups`) and `NTFY_TOKEN_BACKUPS` the token that may publish to it. A
  night where every backup succeeds sends nothing.
- **healthchecks, every run.** When `HEALTHCHECKS_BACKUP_URL` is set, the runner pings it with
  success or failure and the full report. Healthchecks alerts you when a ping fails or does not
  arrive, which also catches a cron job that stopped running.

## Where alerts go

Every alert in the catalog ends in ntfy, except healthchecks, which mails you.

- **ntfy denies everything by default.** Create a user and a token on the server
  (`docker exec -it hl-ntfy ntfy user add`, then `ntfy token add`; ntfy README), and subscribe to
  the topics in the ntfy app with that user.
- **Gatus** posts to `GATUS_NTFY_URL`, topic `GATUS_NTFY_TOPIC_UPTIME` (default `alerts`), with
  `GATUS_NTFY_TOKEN_UPTIME`. With the URL or the token left blank, gatus runs without alerts.
- **The backup runner** posts to `NTFY_URL_BACKUPS` with `NTFY_TOKEN_BACKUPS`.

An ntfy on the server that fails cannot deliver the alert about it. Host ntfy on a different
server from the ones it watches, or use a hosted ntfy topic.
