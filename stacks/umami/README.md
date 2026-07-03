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

Web UI: `https://stats.${DOMAIN}`

## Configuration

```bash
DATABASE_TYPE=postgresql
APP_SECRET=${UMAMI_APP_SECRET}
```

## Script Integration

```html
<script defer src="https://stats.${DOMAIN}/script.js" data-website-id="YOUR-ID"></script>
```

## Resources

- [Umami Website](https://umami.is/)
- [Umami GitHub](https://github.com/umami-software/umami)
