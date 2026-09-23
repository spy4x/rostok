# OmniTools

Self-hosted collection of everyday online tools — all running entirely client-side. Nothing you process (images, PDFs, text, etc.) ever leaves your device.

- **GitHub**: https://github.com/iib0011/omni-tools
- **Docker Hub**: https://hub.docker.com/r/iib0011/omni-tools
- **Demo**: https://omnitools.app

## Features

- Image/Video/Audio Tools — resizer, converter, editor, video trimmer
- PDF Tools — splitter, merger, editor
- Text/List Tools — case converters, list shuffler, text formatters
- Date & Time Tools — date calculators, timezone converters
- Math Tools — prime numbers, electrical calculations
- Data Tools — JSON, CSV, XML tools

## Configuration

```bash
OMNI_TOOLS_DOMAIN=tools.example.com    # Full host for the Traefik rule
OMNI_TOOLS_CPU_LIMIT=0.5                  # Optional (default: 0.5)
OMNI_TOOLS_MEM_LIMIT=256M                 # Optional (default: 256M)
```

The container itself is stateless and needs no persistent storage.

## Access

Dashboard: `https://${OMNI_TOOLS_DOMAIN}` — no default yet (no `+meta.ts`
wizard for this stack); set it in `servers/<server>/.env`, e.g.
`tools.${DOMAIN}`.

## Auth

Public — no authentication required. Share the link with friends and family.
