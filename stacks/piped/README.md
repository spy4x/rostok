# Piped

Privacy-respecting YouTube frontend with no ads.

## Overview

[Piped](https://github.com/TeamPiped/Piped) is an alternative frontend for YouTube that focuses on privacy and performance. It proxies requests to YouTube, removing tracking and ads while providing a clean interface.

## Features

- No ads or tracking
- Subscription management without Google account
- SponsorBlock integration
- LBRY integration for decentralized content
- RSS feeds for channels
- Watch history and playlists
- Lightweight and fast

## Architecture

Consists of three services:

- **Frontend** - User interface (Vue.js)
- **Backend** - API server (Java)
- **Proxy** - Video/image proxy (Go)
- **Database** - PostgreSQL for user data

## Configuration

### Environment Variables

Add to `servers/{server}/.env`:

`rostok stack add piped` writes the database settings to the server's `.env` (see Variables below).

### Config File

Before deployment, a `config.properties` file is generated from the template with your domain settings.

## Access

- **Frontend**: `https://${PIPED_DOMAIN}`
- **API**: `https://${PIPED_API_DOMAIN}`
- **Proxy**: `https://${PIPED_PROXY_DOMAIN}`

## First-Time Setup

1. Open `https://${PIPED_DOMAIN}`
2. Create an account (stored locally in your database)
3. Import subscriptions from YouTube (via OPML or CSV)
4. Configure preferences (quality, autoplay, etc.)

## Resource Usage

- Frontend: ~512M RAM, 1 CPU
- Backend: ~1024M RAM, 2 CPUs
- Proxy: ~512M RAM, 1 CPU
- PostgreSQL: ~256M RAM, 0.5 CPU

## Backup

Included in backup configuration. Backs up:

- PostgreSQL database (user accounts, subscriptions, preferences)

Videos and thumbnails are not stored locally (proxied from YouTube).

## Notes

- May break when YouTube changes their API
- Check [Piped instances status](https://piped-instances.kavin.rocks/) for updates
- Consider using official instances during outages
- Database stores only user preferences, not video content

## Variables

Declared in `+meta.ts`; `rostok stack add piped` writes them to the server's `.env`. Requires the `traefik` stack. Server-level keys (`DOMAIN`, `VOLUMES_PATH`) are shared by every stack. The three hosts need DNS records.

| Key                  | Default                | Meaning                        |
| -------------------- | ---------------------- | ------------------------------ |
| `PIPED_DOMAIN`       | `piped.${DOMAIN}`      | Public host of the frontend    |
| `PIPED_API_DOMAIN`   | `pipedapi.${DOMAIN}`   | Public host of the API         |
| `PIPED_PROXY_DOMAIN` | `pipedproxy.${DOMAIN}` | Public host of the video proxy |
| `PIPED_DB_NAME`      | `piped`                | Postgres database              |
| `PIPED_DB_USER`      | `piped`                | Postgres user                  |
| `PIPED_DB_PASSWORD`  | generated, secret      | Postgres password              |
