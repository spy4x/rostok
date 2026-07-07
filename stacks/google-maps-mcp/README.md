# Google Maps MCP

Search places, geocode, route, and reason about locations via the Model Context Protocol.

- **Upstream**: [cablate/mcp-google-map](https://github.com/cablate/mcp-google-map) (MIT, 356 ⭐)
- **Image**: built locally from pinned release tag (no prebuilt GHCR image yet)
- **Transport**: Streamable HTTP on port 3000
- **Backend**: Google Maps Platform APIs (Places, Routes, Geocoding, …)

## Why this MCP?

Open WebUI agents can now ask: "Find a coffee shop near Shibuya station with rating ≥ 4.3 that's open now" → MCP returns structured place data (name, rating, address, hours, coordinates).

## Tools exposed

18 tools total (14 atomic + 4 composite). Filter via `GOOGLE_MAPS_ENABLED_TOOLS`.

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

### 2. Add env vars to `servers/home/.env`

```bash
#region Google Maps MCP
GOOGLE_MAPS_API_KEY=AIzaSy_YOUR_KEY_HERE
# Optional: restrict to the most common tools
GOOGLE_MAPS_ENABLED_TOOLS=maps_search_places,maps_place_details,maps_geocode,maps_search_nearby
#endregion Google Maps MCP
```

### 3. Deploy

```bash
deno task deploy home google-maps-mcp
```

The first deploy builds the image from source (pin in compose.yml → `MCP_GOOGLE_MAP_VERSION`).
Subsequent deploys are fast (cached).

### 4. Wire into Open WebUI

Add to `TOOL_SERVER_CONNECTIONS` in `stacks/open-webui/compose.yml`:

```json
{
  "url": "http://hl-google-maps-mcp:3000/mcp",
  "type": "mcp",
  "auth_type": "none",
  "headers": {
    "Accept": "application/json, text/event-stream",
    "Content-Type": "application/json"
  },
  "info": {
    "id": "google-maps-mcp",
    "name": "Google Maps",
    "description": "Places, geocoding, directions, weather via Google Maps Platform"
  },
  "config": {
    "enable": true,
    "access_grants": [{ "principal_type": "user", "principal_id": "*", "permission": "read" }]
  }
}
```

Then restart Open WebUI:

```bash
deno task deploy home open-webui
```

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

- API key stored only in `servers/home/.env` (encrypted via age64 to `.env.age`)
- No Traefik labels — MCP only reachable from `proxy` Docker network
- Container has `no-new-privileges:true` and 192M memory limit
- Restrict the key in Google Cloud Console to only the APIs we use

## Troubleshooting

| Symptom                              | Cause                                  | Fix                                                     |
| ------------------------------------ | -------------------------------------- | ------------------------------------------------------- |
| `REQUEST_DENIED` from API            | Billing not enabled or API not enabled | Enable in Google Cloud Console                          |
| `API_KEY_INVALID`                    | Wrong/restricted key                   | Check `GOOGLE_MAPS_API_KEY` in .env, re-issue if needed |
| `OVER_QUERY_LIMIT`                   | Free tier exhausted or quota too low   | Wait or increase quota in Cloud Console                 |
| Tools not appearing in Open WebUI    | TOOL_SERVER_CONNECTIONS misconfigured  | Check JSON syntax; restart Open WebUI container         |
| Container build fails on `git clone` | Network blocked                        | Pre-clone the repo, mount as volume, change Dockerfile  |
