# Route-map coastline data (Sprint 13E Phase 3A)

## Dataset

- **Source:** [Natural Earth](https://www.naturalearthdata.com/) land boundaries
- **Redistribution:** [`world-atlas`](https://github.com/topojson/world-atlas) TopoJSON (`land-50m.json` default)
- **Conversion:** [`topojson-client`](https://github.com/topojson/topojson-client) → GeoJSON at render time

## Licence

- Natural Earth data: **public domain**
- `world-atlas` packaging: **ISC**
- `topojson-client`: **ISC**

On-map attribution is **not** required for Natural Earth public-domain data and is intentionally omitted from SVG artwork.

## Size / resolution

| File | Approx. size | Scale |
|------|--------------|-------|
| `land-50m.json` (default) | ~533 KB | 1:50m |
| `land-110m.json` | ~54 KB | 1:110m |
| `land-10m.json` | ~2.9 MB | 1:10m (optional) |

Default renderer resolution is **50m**, which balances Mediterranean island detail with practical package size.

## Offline

Coastline data is loaded from `node_modules/world-atlas` only. No tile servers, Google Maps, Mapbox, OSM tiles, or live mapping APIs are used.
