# SearXNG

Privacy-respecting metasearch engine. Aggregates results from multiple search engines.

## Access

- Web UI: `https://${SEARXNG_DOMAIN}`
- JSON API: `http://searxng:8080/search?format=json` (internal, for OpenWebUI)

## Integration with OpenWebUI

OpenWebUI searches via SearXNG internally. Set in OpenWebUI env:

- `ENABLE_WEB_SEARCH=true`
- `WEB_SEARCH_ENGINE=searxng`
- `SEARXNG_QUERY_URL=http://searxng:8080/search?format=json`

## Configuration

Settings are in `${VOLUMES_PATH}/searxng/settings/settings.yml`.
Generated from `searxng-settings.yml` template during deployment.

## Search Engines Enabled

- DuckDuckGo, Google, Bing
- Wikipedia, StackOverflow, GitHub, Reddit
- Google Images, Google News

## Variables

Declared in `+meta.ts`; `rostok stack add searxng` writes them to the server's `.env`. Requires the `traefik` stack. Served at `${SEARXNG_DOMAIN}`.

| Key                  | Default            | Meaning                                           |
| -------------------- | ------------------ | ------------------------------------------------- |
| `SEARXNG_DOMAIN`     | `search.${DOMAIN}` | Public host of the search page                    |
| `SEARXNG_SECRET_KEY` | generated, secret  | Written into `settings.yml` by `before.deploy.ts` |
