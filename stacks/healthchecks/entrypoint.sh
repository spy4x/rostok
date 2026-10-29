#!/bin/sh
# Healthchecks entrypoint: exec the image's own start script.
#
# The container runs as UID 999, so /data must already be owned by 999: deploy leaves this
# folder's owner alone (keepOwner in +meta.ts), and a non-root process cannot chown it.
set -e
# run.sh migrates, starts sendalerts and sendreports, then serves on :8000. Calling it
# instead of the web server directly keeps this file working when upstream changes servers
# (v5.0 replaced uwsgi with gunicorn).
exec /opt/healthchecks/run.sh
