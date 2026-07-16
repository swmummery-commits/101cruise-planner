# Cruise Lines/Ships (Cruise Intelligence)

## Source files

- `import-data/CruiseLine_export.csv`
- `import-data/CruiseShip_export.csv`

Do not import itineraries, prices, availability, or scraped deck-plan content.

## Schema

Because `public.cruise_lines` (bigint) and `public.ships` already exist for the Drinks Calculator / planner logos, Cruise Intelligence uses:

- `public.ci_cruise_lines`
- `public.ci_cruise_ships`

Migration files (apply in order):

1. `supabase/migrations/20260716_cruise_intelligence_lines_ships.sql`
2. `supabase/migrations/20260716_ci_simplify_visibility_ordering.sql`
3. `supabase/migrations/20260716_ci_media_and_staterooms.sql` (storage buckets + cabin summary → breakdown)

## Media

Canonical fields:

- `ci_cruise_lines.logo_url`
- `ci_cruise_ships.hero_image_url`

Both external URLs and Supabase Storage public URLs are supported. Binary images are never stored in Postgres.

Storage buckets:

- `cruise-line-logos` (public, max 2 MB — PNG/SVG/WEBP/JPG)
- `ship-images` (public, max 8 MB — WEBP/PNG/JPG; client resizes to ~1800px wide)

Admin upload uses `netlify/functions/ci-media-upload.js` (signed upload, admin auth).

### Migrate legacy logos / heroes

```bash
node scripts/migrate-ci-media.mjs --dry-run
node scripts/migrate-ci-media.mjs --apply
```

Does not overwrite existing CI URLs. Also converts usable `cabin_type_summary` values into `stateroom_breakdown` when breakdown is empty.

## Stateroom breakdown

Editable in Admin → Cruise Lines/Ships → Ships as a dynamic list (`label` + `count`).

Stored in `ci_cruise_ships.stateroom_breakdown` as:

```json
[
  { "label": "Inside", "count": 620 },
  { "label": "The Haven", "count": 40 }
]
```

`cabin_type_summary` (original Base44 `stateroom_types`) is preserved.

Public Ship page donut chart reads `stateroom_breakdown` first, then falls back to object/array `stateroom_types` / `cabin_type_summary`. Only positive numeric categories are shown.

## Sold-by / public rules

- `sold_by_101cruise = true` and `active = true` makes a line publicly visible
- Active ships on a sold active line are public automatically
- Lines list alphabetically by name

## Admin

Single tab: **Cruise Lines/Ships** (legacy Cruise Lines / Ships logo tabs removed from navigation).

Master/detail editing with autosave when selecting another record.

## Ship page lookup

`get-ship` order:

1. Supabase `ci_cruise_ships`
2. Base44 Finder fallback

Planner logos / heroes prefer CI tables, then legacy `cruise_lines` / `ships`.
