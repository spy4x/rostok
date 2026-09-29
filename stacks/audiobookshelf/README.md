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

Declared in `+meta.ts`. Requires the `traefik` stack. Server-level keys (`DOMAIN`, `TIMEZONE`,
`PUID`, `PGID`, `VOLUMES_PATH`) are shared by every stack.

| Key                     | Default                 | Meaning                                  |
| ----------------------- | ----------------------- | ---------------------------------------- |
| `AUDIOBOOKSHELF_DOMAIN` | `books.${DOMAIN}`       | Public host of the web UI                |
| `PATH_BOOKS`            | `${VOLUMES_PATH}/books` | Host folder mounted as the books library |
