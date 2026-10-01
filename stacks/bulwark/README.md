# Bulwark

Modern JMAP webmail client — mail, calendar, contacts, tasks, and files in one
UI. Built with Next.js 16 + TypeScript, connects to Stalwart's JMAP endpoint.

## Purpose

Replaces the retired SnappyMail webmail. Provides a fast, modern email client
that connects directly to the existing [Stalwart](../stalwart/) mail server via
JMAP (RFC 8620) — no IMAP polling, real-time push via EventSource.

## Stack

- **Image**: `ghcr.io/bulwarkmail/webmail:1.7.6`
- **Domain**: `BULWARK_DOMAIN`, default `webmail.${DOMAIN}`
- **Auth**: Own login form (authenticates against Stalwart JMAP). No Authelia or
  basic auth middleware — Bulwark handles authentication natively.
- **Backend**: Connects to `hl-stalwart:8080` (JMAP) on the proxy network.

## Variables

`rostok stack add bulwark` writes these to `.env`:

| Variable                 | Default             | Description                                        |
| ------------------------ | ------------------- | -------------------------------------------------- |
| `BULWARK_DOMAIN`         | `webmail.${DOMAIN}` | Public host of the webmail.                        |
| `BULWARK_ADMIN_PASSWORD` | generated           | Password for the setup wizard and admin dashboard. |
| `BULWARK_SESSION_SECRET` | generated           | Signs admin session cookies.                       |

The JMAP server is `https://mail.${DOMAIN}`, where the `stalwart` stack puts it.

## Initial Setup

1. Deploy: `deno task deploy home bulwark`
2. Visit `https://webmail.${DOMAIN}` — the setup wizard runs automatically on
   first launch.
3. Follow the wizard: configure JMAP server (pre-filled), admin password,
   branding, and security settings.
4. Users log in with their Stalwart email credentials.

## Features

- **Mail**: Threading, unified inbox, full-text search, Sieve filters, S/MIME,
  templates, scheduled send, read receipts
- **Calendar**: Month/week/day views, recurring events, iMIP invitations,
  CalDAV subscriptions
- **Contacts**: Multiple address books, groups, vCard import/export, JMAP sync
- **Tasks**: Due dates, priority, completion tracking (integrated in calendar)
- **Files**: JMAP FileNode browser, WebDAV upload, folder hierarchy
- **PWA**: Install as desktop/mobile app with push notifications

## Backup

Backed up by Restic via [`backup.ts`](./backup.ts) — `settings/` (encrypted
user preferences, AES-256-GCM) and `admin/` (config, branding, plugins,
extensions).

## Security Notes

- Image is pinned to `1.7.6` (not `:latest`).
- Runs with `no-new-privileges:true`.
- Admin settings volume can be made read-only post-setup with
  `ADMIN_CONFIG_READONLY=true` (see upstream docs).
- TOTP 2FA available per-user; OAuth2/OIDC SSO supported for IdP integration.

## See Also

- [Bulwark Documentation](https://bulwarkmail.org/docs)
- [Stalwart Stack](../stalwart/) — Bulwark is the webmail UI for Stalwart's JMAP endpoint

Note: Bulwark is a JMAP webmail client. It is not an authentication
proxy — for SSO, use [Authelia](../authelia/) or [the Stalwart auth endpoints](../stalwart/) directly.
