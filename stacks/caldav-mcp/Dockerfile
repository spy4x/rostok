# ── Multistage: clone → compile → distroless runtime ──
# Source: https://github.com/spy4x/caldav-mcp (single source of truth)

FROM denoland/deno:alpine AS builder

RUN apk add --no-cache git python3
RUN git clone --depth 1 https://github.com/spy4x/caldav-mcp.git /app
WORKDIR /app
# Patches for Stalwart compatibility:
# 1. Regex namespace prefix: Stalwart uses A: instead of C:
# 2. Calendar-home-set regex must match any prefix
# 3. Fallback paths: Stalwart CalDAV is at /dav/cal/, not root
# 4. Don't fallback to VEVENT+VTODO when server explicitly reports empty comp-set
RUN python3 << 'PYEOF'
import re
f = 'caldav/client.ts'
with open(f) as fh: c = fh.read()
# Patch 1: calendar-home-set regex - match any prefix, not just C:
c = c.replace('(?:C:)?calendar-home-set', '(?:[^:]*:)?calendar-home-set')
# Patch 2: comp name regex - match any prefix
c = c.replace('(?:C:)?comp[^>]*name="', '(?:[^:]*:)?comp[^>]*name="')
# Patch 3: fallback URLs - add /dav/cal/ prefix
c = c.replace('${this.baseUrl}/${encodeURIComponent(this.username)}/', '${this.baseUrl}/dav/cal/${encodeURIComponent(this.username)}/')
# Patch 4: skip fallback to [VEVENT,VTODO] when server explicitly returns empty comp-set
old_comp = 'components: components.length > 0 ? components : [ComponentType.VEVENT, ComponentType.VTODO],'
new_comp = 'components: components.length > 0 || block.includes("supported-calendar-component-set") ? components : [ComponentType.VEVENT, ComponentType.VTODO],'
c = c.replace(old_comp, new_comp)
with open(f, 'w') as fh: fh.write(c)
print(f'Patched {f}')
PYEOF
RUN deno compile -A --output /tmp/caldav-mcp main.ts

# ── Runtime: distroless ──
FROM gcr.io/distroless/cc-debian12

COPY --from=builder /tmp/caldav-mcp /usr/local/bin/caldav-mcp

EXPOSE 3000

ENTRYPOINT ["caldav-mcp"]
CMD ["--http"]
