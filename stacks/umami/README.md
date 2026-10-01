# Umami

Privacy-first web analytics — lightweight alternative to Google Analytics.

## Features

- Cookie-free tracking
- Pageviews, events, and session data
- Real-time dashboard
- Team collaboration with user management
- Shareable analytics links
- Proxy path (`/umami/`) for ad-blocker evasion

## Access

Web UI: `https://<UMAMI_DOMAIN>`

## Configuration

| Variable                 | Default           | Meaning                                   |
| ------------------------ | ----------------- | ----------------------------------------- |
| `UMAMI_IMAGE_TAG`        | `latest`          | Image tag                                 |
| `UMAMI_DOMAIN`           | `stats.${DOMAIN}` | Dashboard host                            |
| `UMAMI_PROXY_DOMAIN`     | `${DOMAIN}`       | Site host that proxies `/umami/` to Umami |
| `UMAMI_PROXY_WWW_DOMAIN` | `www.${DOMAIN}`   | The www host of that site                 |
| `UMAMI_DB_PASSWORD`      | generated         | PostgreSQL password                       |
| `UMAMI_APP_SECRET`       | generated         | Umami session secret                      |

The `/umami/` path lets the tracking script load from the tracked site's own domain, which ad
blockers and Safari tracking prevention leave alone. It applies only to sites that this server's
Traefik serves. Point the two proxy variables at another host if your site is not on the apex
domain.

## Script Integration

```html
<script defer src="https://<UMAMI_DOMAIN>/script.js" data-website-id="YOUR-ID"></script>
```

## Resources

- [Umami Website](https://umami.is/)
- [Umami GitHub](https://github.com/umami-software/umami)
