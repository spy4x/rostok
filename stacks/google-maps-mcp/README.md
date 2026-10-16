# Google Maps MCP

Search places, geocode, route, and reason about locations via the Model Context Protocol.

- **Upstream**: [cablate/mcp-google-map](https://github.com/cablate/mcp-google-map) (MIT, 356 ⭐)
- **Image**: built locally from pinned release tag (no prebuilt GHCR image yet)
- **Transport**: Streamable HTTP on port 3000
- **Backend**: Google Maps Platform APIs (Places, Routes, Geocoding, …)

## Why this MCP?

Open WebUI agents can now ask: "Find a coffee shop near Shibuya station with rating ≥ 4.3 that's open now" → MCP returns structured place data (name, rating, address, hours, coordinates).

## Tools exposed

18 tools total (14 atomic + 4 composite). Filter via `GOOGLE_MAPS_MCP_ENABLED_TOOLS`.

### Common tools

| Tool                   | Description                                                            |
| ---------------------- | ---------------------------------------------------------------------- |
| `maps_search_places`   | Free-text place search ("sushi in Tokyo") with rating/open-now filters |
| `maps_search_nearby`   | Find places near a location by type (restaurant, cafe, hotel)          |
| `maps_place_details`   | Full place details by `place_id` — reviews, hours, phone, photos       |
| `maps_geocode`         | Address → coordinates                                                  |
| `maps_reverse_geocode` | Coordinates → address                                                  |
| `maps_directions`      | Step-by-step navigation between two points                             |
| `maps_distance_matrix` | Travel distances/times between multiple origins/destinations           |
| `maps_elevation`       | Elevation in meters for coordinates                                    |
| `maps_timezone`        | Timezone ID, UTC offset, local time                                    |
| `maps_static_map`      | Static map image with markers (multimodal — LLM can "see" the map)     |

### Composite tools

| Tool                      | Description                                     |
| ------------------------- | ----------------------------------------------- |
| `maps_explore_area`       | One-call neighborhood overview                  |
| `maps_plan_route`         | Optimized multi-stop route (up to 25 waypoints) |
| `maps_compare_places`     | Side-by-side comparison                         |
| `maps_local_rank_tracker` | Local SEO rank tracking across geographic grid  |

## Setup

### 1. Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → enable billing
2. **APIs & Services → Library** → enable:
   - Places API (New)
   - Routes API
   - Geocoding API (used internally)
3. **APIs & Services → Credentials** → Create API key
4. **Restrict the key** to the APIs above (recommended)
5. Copy the key (starts with `AIzaSy...`)

Free tier: $200/mo credit covers ~30k place searches. Personal use is essentially free.

### 2. Add the variables

`rostok stack add google-maps-mcp` asks for the key and writes it to the
server's `.env`. The stack builds its image from the `Dockerfile` next to
`compose.yml` and has no Traefik route, so it needs no domain and no
`traefik` stack.

| Key                             | Default          | Meaning                                               |
| ------------------------------- | ---------------- | ----------------------------------------------------- |
| `GOOGLE_MAPS_MCP_API_KEY`       | required, secret | Google Maps API key (Places API (New) and Routes API) |
| `GOOGLE_MAPS_MCP_ENABLED_TOOLS` | `*`              | Comma-separated tool names, or `*` for all 18         |
| `GOOGLE_MAPS_MCP_VERSION`       | `v0.0.52`        | `mcp-google-map` release tag the image is built from  |

Restrict the tool list to shrink the LLM context, e.g.
`maps_search_places,maps_place_details,maps_geocode,maps_search_nearby`.

### 3. Deploy

```bash
rostok deploy <server>
```

The first deploy builds the image from source (pin via `GOOGLE_MAPS_MCP_VERSION` in .env, defaulted in compose.yml's `MCP_GOOGLE_MAP_VERSION` build arg).
Subsequent deploys are fast (cached).

### 4. Wire into Open WebUI

The `open-webui` stack already lists this server among its tool servers, switched off. Set
`OPEN_WEBUI_ENABLE_GOOGLE_MAPS_MCP=true` in the server's `.env` and deploy both stacks:

```bash
rostok deploy <server>
```

Open WebUI's `after.deploy.ts` connects `hl-open-webui` to this stack's `hl-google-maps-mcp`
network.

### 5. Verify

In Open WebUI chat:

> "Find 3 highly rated ramen shops in Shibuya, Tokyo that are open now"
> "Plan a walking route from Tokyo Tower to Senso-ji Temple"
> "What's the air quality in Beijing right now?"

## Google's TOS stance

Using Places API via an LLM is **fully compliant** with Google's TOS:

- ✅ **No explicit ban** on AI-driven queries (Google's own Vertex AI Grounding uses the same APIs)
- ✅ **Caching forbidden** (§3.2.3) — don't store Places results in a DB; query live each time
- ✅ **Attribution required** — show Google branding when rendering Maps results to end users
- ✅ **No reselling** raw API data
- ⚠️ Rate limits enforced per project — see Google Cloud Console

## Cost

| API                          | Free tier      | Per-1k after free |
| ---------------------------- | -------------- | ----------------- |
| Places API (New) Text Search | $200/mo credit | ~$32 / 1K         |
| Places API (New) Details     | included       | ~$17 / 1K (Basic) |
| Routes                       | included       | ~$5–10 / 1K       |
| Geocoding                    | included       | ~$5 / 1K          |

For personal/agentic use (a few hundred queries/month), expect **$0/month**.

## Security

- API key stored only in the server's `.env` (encrypted via age64 to `.env.age`)
- No Traefik labels, and on no shared Docker network: only its own `hl-google-maps-mcp` network,
  which only Open WebUI joins. The endpoint asks for no credential and spends your quota.
- Container has `no-new-privileges:true` and 192M memory limit
- Restrict the key in Google Cloud Console to only the APIs we use

## Troubleshooting

| Symptom                              | Cause                                  | Fix                                                         |
| ------------------------------------ | -------------------------------------- | ----------------------------------------------------------- |
| `REQUEST_DENIED` from API            | Billing not enabled or API not enabled | Enable in Google Cloud Console                              |
| `API_KEY_INVALID`                    | Wrong/restricted key                   | Check `GOOGLE_MAPS_MCP_API_KEY` in .env, re-issue if needed |
| `OVER_QUERY_LIMIT`                   | Free tier exhausted or quota too low   | Wait or increase quota in Cloud Console                     |
| Tools not appearing in Open WebUI    | Switch off, or not on the network      | `OPEN_WEBUI_ENABLE_GOOGLE_MAPS_MCP=true`, then deploy       |
| Container build fails on `git clone` | Network blocked                        | Pre-clone the repo, mount as volume, change Dockerfile      |
