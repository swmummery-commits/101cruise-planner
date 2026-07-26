# Client Portal journey-map geography

Bundled land topologies for the My Cruise dashboard journey map.

## Dataset

| File | Resolution | Approx. size | Use |
|------|------------|--------------|-----|
| `land-50m.json` | 1:50m | ~533 KB | Default — Mediterranean islands (Malta, Balearics, Sicily) remain recognisable |
| `land-110m.json` | 1:110m | ~54 KB | Optional fallback if 50m fails to load |

Format: **TopoJSON** (`objects.land`), redistributed via [`world-atlas`](https://github.com/topojson/world-atlas).

## Source

- [Natural Earth](https://www.naturalearthdata.com/) land boundaries
- Packaged as `world-atlas` TopoJSON (not live tiles)

## Licence

- Natural Earth data: **public domain**
- `world-atlas` packaging: **ISC**
- Browser decode uses vendored `topojson-client` (`js/vendor/topojson-client.min.js`, **ISC**)

Natural Earth public-domain terms do **not** require on-map attribution. Do not add Mapbox, Google Maps, paid tile APIs, or live third-party tile servers.

## Offline rule

Customer dashboard loads these files from this site only (`/assets/geo/…`). Normal use must not depend on an external mapping CDN or API key.
