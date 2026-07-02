# ── Multistage: clone → compile → distroless runtime ──
# Source: https://github.com/spy4x/caldav-mcp (single source of truth)
# Uses fix/stalwart-namespace-compat branch for Stalwart compatibility.
# When PR #1 is merged, switch back to main.

FROM denoland/deno:alpine AS builder

RUN apk add --no-cache git
RUN git clone --depth 1 --branch fix/stalwart-namespace-compat \
    https://github.com/spy4x/caldav-mcp.git /app
WORKDIR /app
RUN deno compile -A --output /tmp/caldav-mcp main.ts

# ── Runtime: distroless ──
FROM gcr.io/distroless/cc-debian12

COPY --from=builder /tmp/caldav-mcp /usr/local/bin/caldav-mcp

EXPOSE 3000

ENTRYPOINT ["caldav-mcp"]
CMD ["--http"]
