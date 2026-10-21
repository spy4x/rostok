#!/bin/sh
# Healthchecks entrypoint: fix perms on /data then exec the image's own start script.
#
# The rostok deploy script chowns bind-mounted volumes to SSH_USER
# (UID 1000 on cloud), but healthchecks container runs as UID 999. Without
# this chown step, sqlite becomes read-only on every deploy and /docs/
# starts returning 500.
#
# `chown ... || true` so a fresh empty bind mount doesn't error.
set -e
chown -R 999:999 /data 2>/dev/null || true
# run.sh migrates, starts sendalerts and sendreports, then serves on :8000. Calling it
# instead of the web server directly keeps this file working when upstream changes servers
# (v5.0 replaced uwsgi with gunicorn).
exec /opt/healthchecks/run.sh
