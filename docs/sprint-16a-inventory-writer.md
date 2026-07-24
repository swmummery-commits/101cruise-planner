# Sprint 16A — Persistent Canonical Inventory Writer

**Status:** LOCAL DEV ONLY · HOLD DEPLOY · DO NOT COMMIT · DO NOT PUSH  
**Date:** 2026-07-24

## Safety

| Check | Result |
|-------|--------|
| Production Supabase ref `xikbibxyinttllxamgao` | **Not written** (hard-blocked) |
| Inventory target | Local SQLite `tmp/dev-inventory/inventory.sqlite` |
| Finder V1 / Engine V2 activation | Untouched / not activated |
| Provider prices | Stripped; never stored |

No separate `SUPABASE_DEV_*` project was configured. Applying DDL to the live Supabase project was refused. Schema + data were applied to a **local development SQLite** database instead.

## Migration status (DEV SQLite)

Applied:

1. `20260735_cruise_canonical_inventory.sql` (SQLite-adapted)
2. `20260736_ports_catalogue_expansion_draft.sql` (ports catalogue seed, 240 ports)
3. `sqlite-dev-adapter-16a`

Production Supabase: `cruise_sailings` still **404** (table absent) — confirmed after import.

## Import statistics (Princess / Track.cruises)

| Metric | Value |
|--------|------:|
| Live API requests | **10** (≤15 cap) |
| Unique sailings imported | **92** (~100 target; API exhausted `has_more` at 92 unique `en_US` Princess rows) |
| Rows created (pass 1) | **92** |
| Rows updated (pass 1) | **0** |
| Rows rejected | **0** |
| Repeat import created | **0** |
| Repeat import unchanged | **92** |
| Duplicate sailings after re-import | **0** (92 → 92) |
| Itinerary update detection | **1 updated** on controlled mutation |
| Unmatched ships | **0** |
| Unmatched port *values* (distinct) | **76** (itinerary labels still unmatched in catalogue; sailings still stored) |
| Route Object eligible stored | **43 / 92** |

## Database statistics (DEV)

| Table | Rows |
|-------|-----:|
| ports | 240 |
| ci_cruise_lines | 42 |
| ci_cruise_ships | 443 |
| cruise_sailings | 92 |
| cruise_sailing_itinerary | 1646 |
| cruise_sailing_sources | 92 |
| cruise_import_runs | 3 |
| distinct canonical_keys | 92 |

## Verifications

- Idempotent writer: second full import → `records_created=0`, sailing count unchanged  
- Source lineage: `provider`, `provider_cruise_id`, `provider_itinerary_id`, `raw_fingerprint` stored  
- Prices: absent from sailings + sources  
- `route_object_eligible` persisted as integer flag  

## Files

| Path | Role |
|------|------|
| `netlify/functions/lib/cruise-finder-v2/inventory/dev-db.js` | DEV DB + production block |
| `netlify/functions/lib/cruise-finder-v2/inventory/apply-dev-schema.js` | Schema + seeds |
| `netlify/functions/lib/cruise-finder-v2/inventory/inventory-writer.js` | Idempotent writer |
| `scripts/run-inventory-import-16a.mjs` | Controlled import CLI |
| `scripts/test-inventory-writer-16a.mjs` | Offline tests |
| `tmp/dev-inventory/*` | DEV DB + reports (gitignored) |

## Tests

`node scripts/test-inventory-writer-16a.mjs` → **8/8 passed** (zero live API calls).

## Recommended next step

1. Provision a dedicated **non-production** Supabase project (or confirm a true DEV project).  
2. Apply `20260735` + ports seed there via SQL editor / `SUPABASE_DEV_*`.  
3. Add a Supabase REST adapter behind the same writer interface.  
4. Continue port catalogue growth to raise Route Object eligibility beyond 43/92.

## Git

Local uncommitted work only. **HOLD DEPLOY. DO NOT COMMIT. DO NOT PUSH.**
