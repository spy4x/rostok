# Audiobookshelf

Audiobook and podcast server with mobile apps.

## Features

- Audiobook library management
- Podcast subscriptions
- Progress tracking across devices
- Mobile apps with offline download
- Collection management

## Access

Web UI: `https://books.${DOMAIN}`

## Mobile Apps

- [iOS App](https://apps.apple.com/app/audiobookshelf/id1592968693)
- [Android App](https://play.google.com/store/apps/details?id=com.audiobookshelf.app)

## Library Organization

```
/audiobooks/
  Author Name/
    Book Title/
      book.m4b
```

## Resources

- [Audiobookshelf Documentation](https://www.audiobookshelf.org/docs)

## Variables

Declared in `+meta.ts`. Requires the `traefik` stack. The stack has no variables of its own;
it reads only server-level keys (`DOMAIN`, `TIMEZONE`, `PUID`, `PGID`, `VOLUMES_PATH`, and `PATH_BOOKS` for the library folder).
