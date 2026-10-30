#!/bin/sh
# Moves a rostok stack's Postgres data from the old layout (Postgres 16 or older in
# <volumes>/<stack>/db) to Postgres 18 in <volumes>/<stack>/postgres, by dump and restore.
#
# Usage, on the server, as root (or a user that may run docker and move the data folder):
#   sh upgrade.sh <volumes-path> <stack>        e.g. sh upgrade.sh /srv/volumes gitea
#
# Run it while the old version of the stack is still running, then `rostok deploy`.
# Steps: docs/usage/postgres-upgrade.md. The old data folder is renamed, never changed or
# deleted, and a failed or interrupted run puts everything back as it was. A run killed before
# it could do that leaves a marker file that stops both a rerun and the deploy guard. Running
# it again after a success does nothing.
set -eu

usage="usage: sh upgrade.sh <volumes-path> <stack>"
volumes=${1:?$usage}
stack=${2:?$usage}
image=${PG_UPGRADE_IMAGE:-postgres:18-alpine}

db=hl-$stack-db
old=$volumes/$stack/db
new=$volumes/$stack/postgres
tmp=$db-upgrade-$$
# Present from before the new cluster is made until its row counts match the old ones.
# stacks/<stack>/before.deploy.ts reads the same path.
marker=$new/.upgrade-incomplete

say() { printf '%s\n' "upgrade $stack: $*"; }
fail() {
  say "$*" >&2
  exit 1
}

# The new layout keeps each major version in <new>/<major>/docker.
has_new_data() {
  for d in "$new"/*/docker; do [ -d "$d" ] && return 0; done
  return 1
}

if [ -e "$marker" ]; then
  previous=unknown
  read -r previous <"$marker" || true
  fail "an earlier run did not finish: $marker exists, so $new may hold part of the data. \
Nothing was deleted: the old data folder is $previous. To try again, move $new away, \
rename that folder back to $old, start the old version of the stack, and run this again."
fi
if has_new_data; then
  [ -d "$old" ] && fail "both $old and $new hold data. Move one of them away first."
  say "already upgraded: $new holds the data. Nothing to do."
  exit 0
fi
[ -d "$old" ] || fail "no old data folder at $old: nothing to upgrade."
if [ -e "$new" ] && [ -n "$(ls -A "$new")" ]; then
  fail "$new exists and is not empty, but holds no Postgres data. Move it away first."
fi

# The running container must be the one that uses the old folder.
source=$(docker inspect -f \
  '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Source}}{{end}}{{end}}' \
  "$db") || fail "container $db not found. Start the old version of the stack first."
[ -n "$source" ] || fail "$db mounts nothing at /var/lib/postgresql/data."
# Compared through the parent folders: the data folder itself is readable by postgres only.
real() { printf '%s/%s' "$(cd "$(dirname "$1")" && pwd -P)" "$(basename "$1")"; }
[ "$(real "$source")" = "$(real "$old")" ] ||
  fail "$db uses $source, not $old."
[ "$(docker inspect -f '{{.State.Running}}' "$db")" = true ] ||
  fail "$db is not running. Start the old version of the stack first."

env_of() {
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$db" | sed -n "s/^$1=//p"
}
user=$(env_of POSTGRES_USER)
password=$(env_of POSTGRES_PASSWORD)
dbname=$(env_of POSTGRES_DB)
[ -n "$user" ] && [ -n "$password" ] && [ -n "$dbname" ] ||
  fail "$db lacks POSTGRES_USER, POSTGRES_PASSWORD or POSTGRES_DB."

major=$(docker exec "$db" psql -X -At -U "$user" -d "$dbname" -c 'SHOW server_version_num')
major=$((major / 10000))
[ "$major" -lt 18 ] || fail "$db already runs Postgres $major."

stamp=$(date +%Y%m%d-%H%M%S)
kept=$volumes/$stack/db-pg$major-$stamp
dump=$volumes/$stack/pg$major-$stamp.sql
log=$volumes/$stack/pg$major-$stamp-restore.log
umask 077

# Every row count of the app's database, one table per line; equal before and after the move.
count_rows() {
  docker exec -i "$1" psql -X -At -v ON_ERROR_STOP=1 -U "$user" -d "$dbname" <<'SQL'
SELECT format('%I.%I %s', table_schema, table_name, (xpath('/row/c/text()', query_to_xml(
  format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1])
FROM information_schema.tables
WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY 1;
SQL
}

project=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$db")
apps=$(docker ps -q --filter "label=com.docker.compose.project=$project" |
  grep -v "^$(docker inspect -f '{{.Id}}' "$db" | cut -c1-12)" || true)

moved=false
done_ok=false
rollback() {
  $done_ok && return
  # A message to a terminal that hung up fails; under set -e that would end the rollback early.
  set +e
  say "failed. Putting the old version back."
  docker rm -f "$tmp" >/dev/null 2>&1 || true
  # The old folder goes back first: if that fails, the new one keeps its marker, so deploy refuses.
  if $moved && mv "$kept" "$old"; then
    [ ! -e "$new" ] || rmdir "$new" 2>/dev/null || mv "$new" "$volumes/$stack/postgres-failed-$stamp"
  fi
  docker start "$db" >/dev/null || true
  # shellcheck disable=SC2086
  [ -z "$apps" ] || docker start $apps >/dev/null || true
  say "the old data is back in $old and the old containers are started. Nothing was deleted."
}
trap rollback EXIT
# dash and busybox sh skip the EXIT trap on a signal (a dropped SSH session sends HUP), but
# run it on an exit from a signal trap.
trap 'exit 1' HUP INT TERM

say "stopping the app containers of project $project"
# shellcheck disable=SC2086
[ -z "$apps" ] || docker stop $apps >/dev/null

before=$(count_rows "$db")
say "dumping Postgres $major to $dump"
docker exec "$db" pg_dumpall -U "$user" >"$dump"
tail -n 5 "$dump" | grep -q 'PostgreSQL database cluster dump complete' ||
  fail "the dump in $dump is incomplete."

docker stop "$db" >/dev/null
mv "$old" "$kept"
moved=true
say "kept the old data folder as $kept"

# 755: the postgres user inside the container must pass through it to its own folder.
mkdir -m 755 "$new" 2>/dev/null || chmod 755 "$new"
printf '%s\n' "$kept" >"$marker"
say "starting $image on $new"
POSTGRES_USER=$user POSTGRES_PASSWORD=$password POSTGRES_DB=$dbname \
  docker run -d --name "$tmp" --network none --pids-limit 500 \
  -e POSTGRES_USER -e POSTGRES_PASSWORD -e POSTGRES_DB \
  -v "$new:/var/lib/postgresql:z" "$image" >/dev/null

# The entrypoint first runs a socket-only server for initdb, then restarts: wait for both.
i=0
until docker logs "$tmp" 2>&1 | grep -q 'init process complete' &&
  docker exec "$tmp" pg_isready -q -U "$user" -d "$dbname"; do
  i=$((i + 1))
  [ "$i" -le 60 ] || fail "$image did not start in 60 seconds: docker logs $tmp"
  sleep 1
done

say "restoring the dump (log: $log)"
docker exec -i "$tmp" psql -X -U "$user" -d postgres <"$dump" >"$log" 2>&1
# The new server already has the app's role and database, made from the same settings.
errors=$(grep 'ERROR:' "$log" |
  grep -v -e "role \"$user\" already exists" -e "database \"$dbname\" already exists" || true)
[ -z "$errors" ] || fail "the restore reported errors (see $log): $errors"

after=$(count_rows "$tmp")
[ "$before" = "$after" ] || fail "row counts differ after the restore. Old: $before New: $after"
say "row counts match in $(printf '%s\n' "$before" | grep -c .) tables"

docker stop "$tmp" >/dev/null
docker rm "$tmp" >/dev/null
rm -f -- "$marker"
done_ok=true
say "done. Postgres 18 data is in $new; the app stays stopped until you run rostok deploy."
say "keep $kept and $dump until the app shows your data; then delete them."
