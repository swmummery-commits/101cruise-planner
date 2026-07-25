# Sprint 16E — Existing Squarespace Asset Migration

HOLD DEPLOY. Do not commit/push unless explicitly requested.

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
| Princess logo + Crown Princess hero | **completed** |
| CI `logo_url` / `hero_image_url` on copy | **unchanged** |
| Squarespace assets deleted | **NO** |
| target inferred from env presence | **NO** — `--target` required |
