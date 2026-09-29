# usememos

Lightweight note-taking app — like a self-hosted Twitter for personal notes.

## Features

- Markdown notes with tags
- Pin, archive, and organize notes
- Link sharing with visibility controls
- REST API for automation
- Dark mode
- Multi-user support

## Access

Web UI: `https://notes.${DOMAIN}`

## Mobile

PWA supported — install from browser for app-like experience.

## Backup

SQLite database backed up nightly via Restic.

## Resources

- [usememos GitHub](https://github.com/usememos/memos)
- [usememos Website](https://usememos.com/)

## Variables

Declared in `+meta.ts`. Requires the `traefik` stack. Server-level keys (`PROJECT`, `DOMAIN`, `VOLUMES_PATH`) are shared by every stack.

| Key               | Default           | Meaning                   |
| ----------------- | ----------------- | ------------------------- |
| `USEMEMOS_DOMAIN` | `notes.${DOMAIN}` | Public host of the web UI |
