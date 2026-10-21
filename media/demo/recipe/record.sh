#!/usr/bin/env bash
# Records the demo video's takes against a throwaway Hetzner Cloud server, deletes the server and
# its SSH key whether the run passed or failed, then encodes media/demo/. See README.md here.
#
#   T="$(sed -n 's/^HETZNER_CLOUD_API_TOKEN=//p' <env file>)" && \
#     HETZNER_CLOUD_API_TOKEN="$T" deno task demo-video [empty work dir]
#
# The takes stay in the work dir (a new temporary one by default), so `deno task demo-video:encode
# <work dir>` can re-encode them. Needs podman, tmux, vhs, ffmpeg, curl, ssh-keygen and Deno with
# Playwright's Chromium.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
WORK="$(cd "${1:-$(mktemp -d)}" && pwd)"
echo "takes go to $WORK"
# The token goes to vm.ts alone: kept in a plain variable and removed from the environment, so
# vhs, tmux, the container and the browser never inherit it.
TOKEN="${HETZNER_CLOUD_API_TOKEN:?HETZNER_CLOUD_API_TOKEN is not set (see README.md)}"
unset HETZNER_CLOUD_API_TOKEN
SOCK="rostokdemo$$"
NAME="rostok-demo-$$"
IMAGE="localhost/rostok-demo:1"
mkdir -p "$WORK/vm"

vm() {
  HETZNER_CLOUD_API_TOKEN="$TOKEN" timeout 900 deno run --allow-net=api.hetzner.cloud \
    --allow-env=HETZNER_CLOUD_API_TOKEN --allow-run=ssh-keygen,ssh -R -W "$HERE/vm.ts" "$@" \
    "$WORK/vm"
}

cleanup() {
  set +e
  tmux -L "$SOCK" kill-server 2>/dev/null
  podman rm -f "$NAME" >/dev/null 2>&1
  echo "deleting the server and its SSH key"
  vm down
}
trap cleanup EXIT INT TERM HUP

capped() { systemd-run --user --scope --quiet -p TasksMax=4000 -p MemoryMax=8G "$@"; }

# One take: the shared settings, then the shot's own tape, with the placeholders filled in.
take() { # <name> <timeout seconds>
  cat "$HERE/tapes/settings.tape" "$HERE/tapes/$1.tape" | sed \
    -e "s|@@OUT@@|$WORK/$1.mp4|" -e "s|@@ATTACH@@|tmux -L $SOCK attach -t demo|" \
    -e "s|@@SSH@@|root@$IP|" -e "s|@@DOMAIN@@|$DOMAIN|" -e "s|@@EMAIL@@|jane@$DOMAIN|" \
    > "$WORK/$1.tape"
  echo "recording $1"
  (cd "$WORK" && capped timeout "$2" vhs "$1.tape" > "$1.log" 2>&1) ||
    { tail -20 "$WORK/$1.log"; return 1; }
}

podman build -q -t "$IMAGE" -f "$HERE/Containerfile" "$HERE" > /dev/null
vm up
IP="$(cat "$WORK/vm/ip")"
DOMAIN="${IP//./-}.sslip.io"
echo "server $IP, domain $DOMAIN"

# The terminal's shell: a clean container inside a tmux session every take attaches to, so the
# install, the home folder and the SSH key are the container's, never this machine's.
cp "$HERE/bashrc" "$WORK/vm/bashrc"
tmux -L "$SOCK" -f /dev/null new-session -d -s demo -x 100 -y 24 \
  "podman run -it --rm --name $NAME --userns=keep-id --pids-limit=500 --memory=8g \
   -v $WORK/vm:/demo:ro,Z --entrypoint bash $IMAGE --rcfile /demo/bashrc -i"
tmux -L "$SOCK" set -g status off
tmux -L "$SOCK" set -g escape-time 0
tmux -L "$SOCK" set -g default-terminal xterm-256color

for t in 01-install 02-wizard 03-server 04-defaults 05-pick; do
  take "$t" 600
done
# The pick moves by count: make sure it ticked the two stacks the captions name, and only them.
picked="$(tmux -L "$SOCK" capture-pane -p -t demo | grep -c '✔' || true)"
if [ "$picked" != 2 ] || ! tmux -L "$SOCK" capture-pane -p -t demo | grep -q '✔ traefik' ||
  ! tmux -L "$SOCK" capture-pane -p -t demo | grep -q '✔ omni-tools'; then
  echo "the picker did not tick exactly traefik and omni-tools: fix the counts in tapes/05-pick.tape"
  exit 1
fi
for t in 06-written 07-deploy; do
  take "$t" 600
done
deploy_started="$(date +%s)"

# The deploy runs on with no client attached. Wait (at most 15 minutes) for the prompt.
deployed=""
for _ in $(seq 1 180); do
  if tmux -L "$SOCK" capture-pane -p -t demo | grep -v '^\s*$' | tail -1 | grep -q 'homelab \$'; then
    deployed=1
    break
  fi
  sleep 5
done
[ -n "$deployed" ] || { echo "the deploy did not finish in 15 minutes"; exit 1; }
# The 7 s the deploy take showed are not part of the cut.
echo $(($(date +%s) - deploy_started + 7)) > "$WORK/deploy-seconds"
tmux -L "$SOCK" capture-pane -p -S -500 -t demo > "$WORK/deploy.txt"
take 08-deployed 300
tmux -L "$SOCK" kill-server
podman rm -f "$NAME" > /dev/null 2>&1 || true

# Let's Encrypt issues the certificate on the first request; wait for a valid one.
URL="https://tools.$DOMAIN/"
for _ in $(seq 1 60); do
  curl -sf --max-time 10 -o /dev/null "$URL" && break
  sleep 5
done
curl -sf --max-time 10 -o /dev/null "$URL"
echo "$URL" > "$WORK/url"
(cd "$REPO" && capped timeout 300 deno run --no-lock -A "$HERE/browser.ts" "$URL" "$WORK")
echo "recorded every take in $WORK"
# The server is not needed for encoding: delete it now rather than at exit.
trap - EXIT INT TERM HUP
cleanup || { echo "check the Hetzner console: the server may still exist"; exit 1; }
set -e
deno run -A "$HERE/encode.ts" "$WORK"
echo "re-encode without recording: deno task demo-video:encode $WORK"
