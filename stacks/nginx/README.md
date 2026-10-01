# Nginx

Generic Nginx web server for serving static content.

## Overview

This stack provides a lightweight Nginx container for static content. It's commonly used for:

- Static website hosting
- Dashboard/homepage
- Landing pages
- HTML documentation

## Features

- Alpine-based image (minimal footprint)
- Read-only volume mount for security
- Traefik integration for automatic SSL
- Resource-limited (128M RAM, 0.10 CPU)

## Configuration

### Basic Deployment

```bash
rostok stack add nginx -s <server>
```

### Content

Place your HTML/CSS/JS files in `servers/{server}/configs/nginx/src/`:

```
servers/home/configs/nginx/src/
├── index.html
├── style.css
└── assets/
```

### Server-Specific Setup

For dynamic content generation (like the homepage), add a `before.deploy.ts` script:

```
servers/{server}/configs/nginx/before.deploy.ts
```

This script runs before deployment and can generate HTML from templates, fetch data, etc.

## Environment Variables

| Variable               | Default         | Meaning                           |
| ---------------------- | --------------- | --------------------------------- |
| `NGINX_IMAGE_TAG`      | `alpine`        | Image tag                         |
| `NGINX_CONTAINER_NAME` | `hl-nginx`      | Container and Traefik router name |
| `NGINX_DOMAIN`         | `www.${DOMAIN}` | Public host of the site           |

The site serves `${PATH_APPS}/configs/nginx/src`, which deploy fills from
`servers/<server>/configs/nginx/src/` in your project. Put an `index.html` there before the first
deploy: an empty folder answers 403.

## Access

Service is available at `https://<NGINX_DOMAIN>`, for example `https://www.example.com`.

## Notes

- Content is mounted read-only for security
- One instance per server through `rostok stack add`: the container name comes from
  `NGINX_CONTAINER_NAME`, and a server's `.env` holds one value for it. A second copy under another
  `deployAs` name needs its own container name, which only a compose override can give it.
- No persistent data beyond the mounted content directory
