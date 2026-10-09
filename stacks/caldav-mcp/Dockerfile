# ── Multistage: clone → compile → distroless runtime ──
# Source: https://github.com/spy4x/caldav-mcp (single source of truth)
# Both images are pinned by digest, the source by commit and its dependencies by caldav-mcp.lock,
# so a rebuild makes the same binary (spy4x/rostok#356). To upgrade, change them together.
FROM denoland/deno:alpine-2.9.7@sha256:8ce780168429c4bf5962652e6cbea3fd45254ae902069e90585fb33f74c56968 AS builder

# An exact tag: a new value changes this step, so Docker's build cache never keeps an old clone.
ARG CALDAV_MCP_VERSION=v1.3.0
# The commit that tag pointed at when it was pinned. A tag can move; the build fails if it has.
ARG CALDAV_MCP_COMMIT=789c52b4b92867b7ba67aeb0edfde1de9d7c05ea
# The CalDAV server URL. Its host is the only outbound host the binary may reach besides claude.ai.
ARG CALDAV_URL
RUN apk add --no-cache git
RUN git clone --depth 1 --branch "${CALDAV_MCP_VERSION}" \
    https://github.com/spy4x/caldav-mcp.git /app \
  && test "$(git -C /app rev-parse HEAD)" = "${CALDAV_MCP_COMMIT}"
WORKDIR /app
# caldav-mcp commits no lockfile, so this stack keeps one, made from the pinned commit. --frozen
# fails the build instead of resolving a newer dependency. Regenerate it on every upgrade: in a
# clone at the new commit, run `deno cache --unstable-kv main.ts` and copy its deno.lock here.
COPY caldav-mcp.lock /app/deno.lock
# Explicit permissions instead of -A, baked into the binary:
# - net: listen on 0.0.0.0:3000, reach the CalDAV host, and fetch connector metadata from
#   claude.ai (caldav-mcp's TRUSTED_CLIENT_HOSTS). Before that fetch it resolves claude.ai with
#   Deno.resolveDns, which needs the nameserver too: 127.0.0.11:53, Docker's resolver on a
#   user-defined network such as `proxy`. Without it every connector sign-in fails "Unknown client";
# - read/write: only /data, where the OAuth store lives;
# - env: the settings in compose.yml.
RUN caldav_host="$(printf '%s' "${CALDAV_URL}" | sed -E 's#^[a-zA-Z][a-zA-Z0-9+.-]*://([^/@]*@)?([^/?#]+).*$#\2#')" \
  && case "${caldav_host}" in ""|*://*|*/*) echo "CALDAV_URL must be an http(s) URL" >&2; exit 1;; esac \
  && deno compile --frozen --unstable-kv \
    --allow-net="0.0.0.0:3000,${caldav_host},claude.ai,127.0.0.11:53" \
    --allow-read=/data --allow-write=/data --allow-env \
    --output /tmp/caldav-mcp main.ts

# ── Runtime: distroless, no root ──
FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f

COPY --from=builder /tmp/caldav-mcp /usr/local/bin/caldav-mcp

EXPOSE 3000
VOLUME /data

ENTRYPOINT ["caldav-mcp"]
CMD ["--http"]
