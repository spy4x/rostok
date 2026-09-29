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

## Variables

`rostok stack add omni-tools` writes these to the server's `.env`. Requires
the `traefik` stack.

| Key                    | Default           | Meaning                        |
| ---------------------- | ----------------- | ------------------------------ |
| `OMNI_TOOLS_DOMAIN`    | `tools.${DOMAIN}` | Full host for the Traefik rule |
| `OMNI_TOOLS_CPU_LIMIT` | `0.5`             | CPU limit of the container     |
| `OMNI_TOOLS_MEM_LIMIT` | `256M`            | Memory limit                   |

The container itself is stateless and needs no persistent storage.

## Access

Dashboard: `https://${OMNI_TOOLS_DOMAIN}`.

## Auth

Public — no authentication required. Share the link with friends and family.
