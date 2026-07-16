# Cruise Intelligence migration (Base44 → Supabase)

## Source files

- `import-data/CruiseLine_export.csv`
- `import-data/CruiseShip_export.csv`

Do not import itineraries, prices, availability, or scraped deck-plan content.

## Schema

Because `public.cruise_lines` (bigint) and `public.ships` already exist for the Drinks Calculator / planner logos, Cruise Intelligence uses:

- `public.ci_cruise_lines`
- `public.ci_cruise_ships`

Migration files:

1. `supabase/migrations/20260716_cruise_intelligence_lines_ships.sql`
2. `supabase/migrations/20260716_ci_simplify_visibility_ordering.sql` (alphabetical order; remove `display_order`, `public_visible`, `excluded_reason`)

Apply both in order in the Supabase SQL editor (or CLI) before relying on Admin / public APIs.

## Required SQL step

Apply the migration in the Supabase SQL editor (or CLI) before importing:

1. Open Supabase → SQL
2. Run `20260716_cruise_intelligence_lines_ships.sql`
3. Confirm tables `ci_cruise_lines` and `ci_cruise_ships` exist

## Environment variables

For the import script (local only — never embed in browser code):

```bash
export SUPABASE_URL="https://YOUR_PROJECT.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="YOUR_SERVICE_ROLE_KEY"
```

Netlify already uses these for server functions. Do not expose the service-role key to Squarespace or client JS.

## Dry run

```bash
node scripts/import-base44-cruise-data.mjs --dry-run
```

## Real import

```bash
node scripts/import-base44-cruise-data.mjs --apply
```

Safe to re-run: upserts on `legacy_base44_id`.

## Sold-by / public rules

- Approved 101cruise lines from Cruise Finder config are imported as `sold_by_101cruise = true`
- `sold_by_101cruise = true` and `active = true` makes a line publicly visible (no separate `public_visible` column)
- Other lines are imported as reference rows with `needs_review = true`
- P&O Cruises Australia matching rules set `sold_by_101cruise = false` and `active = false`
- Cruise lines always list alphabetically by name (no `display_order`)
- Public APIs and RLS only expose active sold lines (and their active ships)
- Active ships on a sold active line are public automatically

## Adding a new approved cruise line later

1. Admin → Cruise Intelligence → Cruise Lines → Add (or edit an imported review row)
2. Set **Sold by 101cruise = Yes** (and keep **Active = Yes**)
3. Add / import ships for that line
4. Do not store itineraries

## Ship page lookup

`get-ship` order:

1. Supabase `ci_cruise_ships`
2. Base44 Finder fallback

Fallback usage is logged as `ship_lookup_matched` with `source: "base44_fallback"`.

## Retiring Base44 after verification

When Supabase coverage is complete for booked ships:

1. Confirm logs show few/no Base44 fallbacks
2. Keep Base44 credentials temporarily
3. Remove Base44 fallback from `get-ship.js` in a later sprint
4. Do not delete Base44 until verification is signed off

## Rollback

- Data: truncate or delete from `ci_cruise_ships` then `ci_cruise_lines`
- Schema: drop those two tables if needed (does not affect drinks-calculator `cruise_lines` / `ships`)
- App: Ship page continues to use Base44 when Supabase has no match

## Cost

Catalogue text/JSON only — negligible Supabase storage. No image uploads and no paid add-ons in this phase.
