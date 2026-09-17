#!/bin/sh
# Healthchecks entrypoint: fix perms on /data then exec the original CMD.
#
# The rostok deploy script chowns bind-mounted volumes to HOMELAB_USER
# (UID 1000 on cloud), but healthchecks container runs as UID 999. Without
# this chown step, sqlite becomes read-only on every deploy and /docs/
# starts returning 500.
#
# `chown ... || true` so a fresh empty bind mount doesn't error.
set -e
chown -R 999:999 /data 2>/dev/null || true
exec uwsgi /opt/healthchecks/docker/uwsgi.ini
