# Sprint 16E — Existing Squarespace Asset Migration

**Status: COMPLETE.** All Squarespace-hosted CI logo and ship-hero candidates
have been copied into `cruise-media` + `media_library` and promoted into
canonical `logo_url` / `hero_image_url` fields in the Original project.

Final read-only Original inventory: **Candidates = 0** (`assets_inspected` 0,
`proposed_uploads` 0, `proposed_media_library_records` 0,
`proposed_canonical_url_changes` 0). DEV writes throughout = 0.

**Total migrated from Squarespace: 42 assets** (21 cruise-line logos + 21 ship
hero images). Squarespace originals were **not** deleted. Rollback manifests and
batch reports remain local under `tmp/` (gitignored) and are never committed.

HOLD DEPLOY unless explicitly requested.

## Objective

Copy Squarespace-hosted (and optionally other remote) CI logos/heroes into the
existing Media Library architecture (`cruise-media` + `media_library`), then
optionally promote verified Supabase URLs into `logo_url` / `hero_image_url`.

## Existing migration ownership (reused)

| Process | Role |
|---|---|
| `scripts/migrate-ci-media.mjs` | **CI field ownership** for media URLs — copies legacy `cruise_lines.logo_url` / `ships.hero_image_url` **string values** into CI tables. Does **not** download binaries. |
| Sprint 16D bulk ship import | Shared hash / path / Media Library insert conventions (`content_hash`, `import_source`, `ships/{ship_id}/{hash12}-…`) |
| **`scripts/migrate-squarespace-ci-media.mjs`** | Sprint 16E binary migration — sole writer for Squarespace→Storage copy and explicit CI URL promote |

Do not introduce another independent writer to `logo_url` / `hero_image_url`.

## Additive schema

`supabase/migrations/20260738_media_library_squarespace_migration.sql`

- `media_library.source_url` — preserves original Squarespace (or other) URL
- `media_type` allows `cruise_line`
- unique `(cruise_line_id, content_hash)` for logo dedupe

Requires Sprint 16D migration `20260737_…` (`content_hash`, `import_source`, `original_filename`) first.

## Explicit target (required)

The script **never** infers DEV vs production from whichever env vars exist.
`--target` is mandatory.

| Target | Env vars used | Project ref |
|---|---|---|
| `--target=dev` | `SUPABASE_DEV_URL`, `SUPABASE_DEV_SERVICE_ROLE_KEY` | `vkheexbapykcdfbqcach` |
| `--target=production` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` only | `xikbibxyinttllxamgao` |

## Original-project single-line workflow

Production work is **one cruise line at a time**. Confirmation tokens are the
**exact cruise-line UUID** (never a name).

```bash
# Dry run (read-only)
node scripts/migrate-squarespace-ci-media.mjs \
  --dry-run \
  --target=production \
  --line-id <LINE_UUID>

# Copy → cruise-media + media_library only (CI URLs unchanged)
node scripts/migrate-squarespace-ci-media.mjs \
  --copy \
  --target=production \
  --line-id <LINE_UUID> \
  --confirm-production-copy=<LINE_UUID>

# Promote → verified sequential update with compensating rollback
node scripts/migrate-squarespace-ci-media.mjs \
  --promote \
  --target=production \
  --line-id <LINE_UUID> \
  --confirm-production-promote=<LINE_UUID>
```

**Blocked on Original:** all-lines copy/promote, `--ship-id`, `--ids` lists,
broad rollback, deletes, Squarespace deletion.

**Copy gates:** line exists; UUID confirmation matches `--line-id`; 1–10
candidates; every candidate belongs to that line; reachable; valid MIME; not
oversized; no SSRF/broken URLs; dry-run plan succeeds first; duplicate
protection remains active.

**Promote gates:** matching verified Media Library rows for each remaining
Squarespace field; content hash; `source_url` matches current canonical
Squarespace URL; Supabase `public_url` reachable; ship/line relationships
correct; 1–10 candidates; verified PATCH (exactly one row + re-read);
rollback manifest written before the first CI update.

**Admin warning (printed before promote):** Close any open Cruise Database edit
form for this cruise line and its affected ships before continuing. Reopen or
hard-refresh the Admin after promotion.

### Completed: Princess Cruises

Line `c19f40a7-c160-4035-a845-14dada550e1f` — logo + Crown Princess hero copied
and promoted; live Admin verified.

Princess-only `--repair-logo` remains available for audit/history (not the
general workflow):

```bash
node scripts/migrate-squarespace-ci-media.mjs \
  --repair-logo \
  --target=production \
  --line-id c19f40a7-c160-4035-a845-14dada550e1f \
  --confirm-production-logo-repair=PRINCESS
```

### Batch 1 — logo-only lines (COMPLETED)

**Status: completed in Original project.** Copy + promote finished **13/13**.
DEV writes = 0.

Completed lines (logo `ci_cruise_lines.logo_url` only):

1. Norwegian Cruise Line  
2. Carnival Cruise Line  
3. Silversea Cruises  
4. Seabourn Cruise Line  
5. MSC Cruises  
6. Scenic Luxury Cruises & Tours  
7. Regent Seven Seas Cruises  
8. Virgin Voyages  
9. AMA Waterways  
10. Viking Ocean Cruises  
11. Emerald Cruises  
12. Holland America Line  
13. Cunard Line  

Also completed earlier (outside Batch 1): Princess Cruises logo + Crown Princess
hero.

Runner: `scripts/migrate-squarespace-batch.mjs` with fixed approved list
`batch-1-logo-lines`. Norwegian was already in Media Library at copy time
(`skipped_already_migrated`); remaining lines were copied then all 13 promoted.

```bash
# Historical Batch 1 commands (already executed successfully)
node scripts/migrate-squarespace-batch.mjs \
  --dry-run \
  --target=production \
  --batch=batch-1-logo-lines \
  --confirm-production-batch=BATCH-1-LOGOS

node scripts/migrate-squarespace-batch.mjs \
  --copy \
  --target=production \
  --batch=batch-1-logo-lines \
  --confirm-production-batch=BATCH-1-LOGOS

node scripts/migrate-squarespace-batch.mjs \
  --promote \
  --target=production \
  --batch=batch-1-logo-lines \
  --confirm-production-batch=BATCH-1-LOGOS
```

Reports remain local under `tmp/squarespace-migration/batches/` (gitignored).
No combined copy+promote mode. On failure the batch stops; earlier lines are
not auto-undone.

### Batch 2 — mixed logo + ship-hero lines (COMPLETED)

**Status: completed in Original project.** Copy + promote finished **6/6**.
DEV writes = 0. Disney Cruise Line was not included.

Completed lines (logo `ci_cruise_lines.logo_url` + ship
`ci_cruise_ships.hero_image_url`):

| # | Cruise line | Fields promoted | Ships |
|---|---|---|---|
| 1 | Celebrity Cruises | 3 | Celebrity Edge, Celebrity Millennium |
| 2 | Atlas Cruises | 4 | World Adventurer, World Navigator, World Traveller |
| 3 | Azamara | 4 | Journey, Pursuit, Quest |
| 4 | Explora Journeys | 4 | EXPLORA I, EXPLORA II, EXPLORA III |
| 5 | Oceania Cruises | 2 | Allura |
| 6 | Royal Caribbean International | 2 | Icon of the Seas |

Totals: **6** logo_url + **13** hero_image_url = **19** verified promoted
fields. Canonical names / UUIDs / counts are hardcoded from dry-run
`tmp/squarespace-migration/dry-run-1784950810217.json` (Atlas is
**Atlas Cruises**, not “Atlas Ocean Voyages”).

Runner: `scripts/migrate-squarespace-batch.mjs` with fixed approved list
`batch-2-mixed-lines`. Copy wrote only `cruise-media` + `media_library`.
Promote used verified sequential updates with compensating rollback.

```bash
# Historical Batch 2 commands (already executed successfully)
node scripts/migrate-squarespace-batch.mjs \
  --dry-run \
  --target=production \
  --batch=batch-2-mixed-lines \
  --confirm-production-batch=BATCH-2-MIXED

node scripts/migrate-squarespace-batch.mjs \
  --copy \
  --target=production \
  --batch=batch-2-mixed-lines \
  --confirm-production-batch=BATCH-2-MIXED

node scripts/migrate-squarespace-batch.mjs \
  --promote \
  --target=production \
  --batch=batch-2-mixed-lines \
  --confirm-production-batch=BATCH-2-MIXED
```

### Batch 3 — Disney Cruise Line (COMPLETED)

**Status: completed in Original project.** Copy + promote finished **1/1**.
DEV writes = 0.

Exactly one cruise line: **Disney Cruise Line**
(`8f7aadcb-7843-4060-b0cb-a60631936b3a`).

| Asset | Name |
|---|---|
| Logo | Disney Cruise Line |
| Ship heroes (7) | Disney Magic, Disney Adventure, Disney Wish, Disney Treasure, Disney Fantasy, Disney Dream, Disney Wonder |

Totals: **1** logo_url + **7** hero_image_url = **8** verified promoted fields.
Canonical names / UUIDs / counts hardcoded from dry-run
`tmp/squarespace-migration/dry-run-1784951494180.json`.

Runner: `scripts/migrate-squarespace-batch.mjs` with fixed approved list
`batch-3-disney`. Copy wrote only `cruise-media` + `media_library`. Promote used
verified sequential updates with compensating rollback.

```bash
# Historical Batch 3 commands (already executed successfully)
node scripts/migrate-squarespace-batch.mjs \
  --dry-run \
  --target=production \
  --batch=batch-3-disney \
  --confirm-production-batch=BATCH-3-DISNEY

node scripts/migrate-squarespace-batch.mjs \
  --copy \
  --target=production \
  --batch=batch-3-disney \
  --confirm-production-batch=BATCH-3-DISNEY

node scripts/migrate-squarespace-batch.mjs \
  --promote \
  --target=production \
  --batch=batch-3-disney \
  --confirm-production-batch=BATCH-3-DISNEY
```

### Migration complete summary

| Wave | Scope | Assets |
|---|---|---|
| Princess (single-line) | logo + Crown Princess hero | 2 |
| Batch 1 | 13 cruise-line logos | 13 |
| Batch 2 | 6 logos + 13 ship heroes | 19 |
| Batch 3 | Disney logo + 7 ship heroes | 8 |
| **Total** | **21 logos + 21 ship heroes** | **42** |

Final Original read-only dry-run inventory after Batch 3: **Candidates = 0**.
Squarespace source URLs were preserved in `media_library.source_url`; Squarespace
binaries were never deleted.

## Post-migration coverage audit (read-only)

After Sprint 16E completed, a read-only Original-project audit measured **overall**
catalogue media completeness (not only Squarespace migration status):

```bash
node scripts/audit-cruise-media-coverage.mjs --target=production
```

Script: `scripts/audit-cruise-media-coverage.mjs` (GET/HEAD only). Reports under
`tmp/media-coverage-audit/` (gitignored). Offline test:
`node scripts/test-audit-cruise-media-coverage.mjs`.

### Verified coverage totals

| Metric | Count |
|---|---|
| Total cruise lines | 42 |
| Supabase logos | 30 |
| Other external logos | 0 |
| Missing logos | 12 |
| Total ships | 448 |
| Supabase hero images | 24 |
| Other external heroes | 0 |
| Missing hero images | 424 |
| Remaining Squarespace URLs | 0 |
| Broken URLs | 0 |
| Relationship errors | 0 |
| Orphan warnings | 0 |
| Duplicate-record warnings | 1 |
| Database / Storage / DEV writes | 0 / 0 / 0 |

### Cruise lines with missing logos

These lines had no `logo_url` in the canonical catalogue (not a Squarespace
migration failure — there was no URL to migrate). **Hurtigruten is now
complete** via approved local logo import (see below). Remaining gaps:

1. Lindblad Expeditions  
2. American Queen Voyages  
3. American Cruise Lines  
4. Australis  
5. Marella Cruises  
6. Hapag-Lloyd Cruises  
7. Ponant  
8. Ritz-Carlton Yacht Collection  
9. AIDA Cruises  
10. Hansa Touristik  
11. Fred Olsen Cruise Lines  

### Approved local logo import (Hurtigruten) — complete

Steve visually reviewed and approved this exact local file as the canonical
**Hurtigruten** logo. The asset is **Hurtigruten coastal branding, not HX**.

Source (local, not in Git):

`/Users/stevemummery/Documents/101Cruise/MARKETING/LOGOS/Cruise Line Logos (500 x 500 px)/hurtigruten.png`

| Field | Value |
|---|---|
| Canonical name | Hurtigruten |
| Canonical UUID | `297df8d9-6d36-4855-993d-e30bbfaf29e0` |
| Media Library UUID | `dc9e4c55-2ad8-4dda-83d2-00df8228707b` |
| Storage path | `lines/297df8d9-6d36-4855-993d-e30bbfaf29e0/8a87e5bc6717-hurtigruten.png` |
| Content hash (SHA-256) | `8a87e5bc67173dd0ae8ed460891a4d0e8a3765d6c11ae294cf0ebbad49e04041` |
| Public URL | `https://xikbibxyinttllxamgao.supabase.co/storage/v1/object/public/cruise-media/lines/297df8d9-6d36-4855-993d-e30bbfaf29e0/8a87e5bc6717-hurtigruten.png` |
| Import source | `approved_local_logo` |
| Dimensions | 500 × 500 PNG |
| Brand | Hurtigruten coastal — **not HX** |

Live Original-project apply result:

- Storage uploads: **1**
- Media Library inserts: **1**
- Cruise-line updates (`logo_url` only): **1**
- Database deletes: **0**
- Storage deletes: **0**
- DEV writes: **0**

Importer: `scripts/import-approved-line-logo.mjs`  
Config: `scripts/lib/approved-line-logo-import/hurtigruten.js`  
Confirmation token: `IMPORT-HURTIGRUTEN-LOGO`  
Strategy: verified sequential import with rollback evidence  

Rollback evidence and apply/dry-run reports remain under gitignored
`tmp/media-coverage-audit/` (not committed).

```bash
node scripts/import-approved-line-logo.mjs \
  --dry-run \
  --target=production \
  --logo=hurtigruten \
  --confirm=IMPORT-HURTIGRUTEN-LOGO

node scripts/import-approved-line-logo.mjs \
  --apply \
  --target=production \
  --logo=hurtigruten \
  --confirm=IMPORT-HURTIGRUTEN-LOGO
```

Offline tests: `node scripts/test-import-approved-line-logo.mjs`

### 424 missing ship heroes

**Not migration failures.** Those ships had no existing `hero_image_url` in the
canonical catalogue, so Sprint 16E correctly had nothing to copy or promote.
Filling gaps requires new source imagery (e.g. Sprint 16D bulk ship import), not
re-running Squarespace migration.

### Royal Caribbean logo duplicate — resolved

Coverage audit warning for **Royal Caribbean International**
(`1cea3c83-5fd5-41d0-b5f7-4026fee00ab5`) was an **old superseded Media Library
logo row**, not a broken canonical logo.

| Role | Media Library UUID | Notes |
|---|---|---|
| Canonical (kept) | `28a9063c-c508-4b0b-a535-f03c49ae2a24` | Matches `ci_cruise_lines.logo_url`; `squarespace_ci_migration` |
| Superseded (deleted) | `ba55f15e-eb84-4c4c-a489-d16663ad4917` | Older `general` upload; removed by gated cleanup |

Cleanup (completed):
`scripts/cleanup-royal-caribbean-logo-duplicate.mjs` — exactly one gated
`media_library` DELETE. Banner reports
`Writes: gated Original-project Media Library delete only`.

- Canonical `ci_cruise_lines.logo_url` **unchanged**
- Icon of the Seas Media Library row **untouched**
- Superseded Storage object `general/1784610209293-d1622233-RC.jpg` **still
  exists** (separate later garbage collection; not deleted by cleanup)
- Coverage duplicate warning is **resolved**
- DEV writes: 0

Investigation helper (read-only):
`scripts/investigate-royal-caribbean-logo-duplicate.mjs`

## DEV commands

```bash
node scripts/migrate-squarespace-ci-media.mjs --dry-run --target=dev
node scripts/migrate-squarespace-ci-media.mjs --copy --target=dev --line-id <uuid>
node scripts/migrate-squarespace-ci-media.mjs --promote --target=dev --from-copy tmp/squarespace-migration/copy-….json
node scripts/migrate-squarespace-ci-media.mjs --rollback --target=dev --manifest tmp/squarespace-migration/rollback-manifest-….json
```

Scopes on DEV: `--line-id`, `--ship-id`, `--ids a,b`, `--logos-only`,
`--ships-only`, `--all-hosts` (default Squarespace-only).

## Two-phase behaviour

1. **COPY** — download → hash → dedupe → upload `cruise-media` → insert/reuse `media_library` → verify public URL. **CI URLs unchanged.**
2. **PROMOTE** — patches `logo_url` / `hero_image_url` to verified Supabase URLs using verified sequential update with compensating rollback; writes rollback manifest first.

Rollback restores CI URLs only. Never deletes Squarespace or Supabase objects.
Broad Original-project rollback is **not** enabled.

## Paths

- Logos: `cruise-media/lines/{line_id}/{hash12}-{safeFilename}`
- Ships: `cruise-media/ships/{ship_id}/{hash12}-{safeFilename}` (same as 16D)

`import_source = squarespace_ci_migration`

## Tests

```bash
node scripts/test-squarespace-ci-media.mjs
node scripts/test-squarespace-target.mjs
node scripts/test-squarespace-production-promote.mjs
node scripts/test-squarespace-verified-patch.mjs
node scripts/test-squarespace-batch.mjs
node scripts/test-squarespace-batch-2.mjs
node scripts/test-squarespace-batch-3.mjs
node scripts/test-audit-cruise-media-coverage.mjs
node scripts/test-cleanup-royal-caribbean-logo-duplicate.mjs
```

Mocked / pure offline tests only. No live network calls in the test suite.

## Image processing

V1 does **not** use `sharp`. Dimensions/sizes are reported; oversized originals flagged.
Adding server-side optimisation before full production migrate is recommended for
assets above ~4 MB (or logos above ~2 MB) — package/build impact if `sharp` is
added later (native binary, Netlify function size, cold start).

## Production safety confirms

| Check | Status |
|---|---|
| production rollback | **blocked** |
| production copy | **gated** (single line + UUID confirm; media_library + cruise-media) |
| production promote | **gated** (single line + UUID confirm; verified sequential + compensating rollback) |
| production logo repair | **gated** (Princess logo_url only; historical) |
| Batch 1 logo lines (13) | **completed** (copy + promote; DEV writes = 0) |
| Batch 2 mixed lines (6, non-Disney) | **completed** (copy + promote; 19 fields; DEV writes = 0) |
| Batch 3 Disney Cruise Line (8 assets) | **completed** (copy + promote; DEV writes = 0) |
| Princess logo + Crown Princess hero | **completed** |
| Final Original inventory | **Candidates = 0** |
| Total Squarespace assets migrated | **42** (21 logos + 21 ship heroes) |
| CI `logo_url` / `hero_image_url` on copy | **unchanged** |
| Squarespace assets deleted | **NO** |
| Rollback manifests / tmp reports in Git | **NO** (gitignored) |
| Coverage audit reports under `tmp/` | **NO** (gitignored) |
| target inferred from env presence | **NO** — `--target` required |
| Sprint 16E Squarespace CI media migration | **COMPLETE** |
| Post-migration coverage audit | **verified** (42 lines / 448 ships; 12 missing logos; 424 missing heroes = no prior URL) |
| Royal Caribbean logo ML duplicate | **resolved** (superseded ML row deleted; canonical logo unchanged; Storage GC later) |
