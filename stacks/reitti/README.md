# Reitti

Public transit route planner with map tiles.

## Features

- Public transit routing (HSL region / Helsinki)
- Interactive map with route visualization
- Tile caching for map rendering
- PostGIS-backed geographic data
- Redis caching for performance

## Access

Web UI: `https://loc.${DOMAIN}`

## Architecture

| Service        | Role                                 |
| -------------- | ------------------------------------ |
| **Reitti**     | Route planning engine and web UI     |
| **PostGIS**    | Geospatial database for transit data |
| **Redis**      | Session and query caching            |
| **Tile Cache** | Map tile proxy and caching (nginx)   |

## Resources

- [Reitti GitHub](https://github.com/dedicatedcode/reitti)
