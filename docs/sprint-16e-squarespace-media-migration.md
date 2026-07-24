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

## Additive schema (unapplied)

`supabase/migrations/20260738_media_library_squarespace_migration.sql`

- `media_library.source_url` — preserves original Squarespace (or other) URL
- `media_type` allows `cruise_line`
- unique `(cruise_line_id, content_hash)` for logo dedupe

Requires Sprint 16D migration `20260737_…` (`content_hash`, `import_source`, `original_filename`) first.

## Modes

```bash
# Read-only plan (safe against prod if network works)
node scripts/inventory-ci-image-urls.mjs
node scripts/migrate-squarespace-ci-media.mjs --dry-run
node scripts/migrate-squarespace-ci-media.mjs --dry-run --line-id <uuid>
node scripts/migrate-squarespace-ci-media.mjs --dry-run --logos-only
node scripts/migrate-squarespace-ci-media.mjs --dry-run --ships-only

# Writes require SUPABASE_DEV_* (refused otherwise)
node scripts/migrate-squarespace-ci-media.mjs --copy --line-id <uuid>
node scripts/migrate-squarespace-ci-media.mjs --promote --from-copy tmp/squarespace-migration/copy-….json
node scripts/migrate-squarespace-ci-media.mjs --rollback --manifest tmp/squarespace-migration/rollback-manifest-….json
```

Scopes: `--line-id`, `--ship-id`, `--ids a,b`, `--logos-only`, `--ships-only`, `--all-hosts` (default is Squarespace-only).

## Two-phase behaviour

1. **COPY** — download → hash → dedupe → upload `cruise-media` → insert/reuse `media_library` → verify public URL. **CI URLs unchanged.**
2. **PROMOTE** — only after explicit approval; patches `logo_url` / `hero_image_url` to verified Supabase URLs; writes rollback manifest.

Rollback restores CI URLs only. Never deletes Squarespace or Supabase objects.

## Paths

- Logos: `cruise-media/lines/{line_id}/{hash12}-{safeFilename}`
- Ships: `cruise-media/ships/{ship_id}/{hash12}-{safeFilename}` (same as 16D)

`import_source = squarespace_ci_migration`

## Tests

```bash
node scripts/test-squarespace-ci-media.mjs
```

Mocked network only. No production writes.

## Image processing

V1 does **not** use `sharp`. Dimensions/sizes are reported; oversized originals flagged.
Adding server-side optimisation before full production migrate is recommended for
assets above ~4 MB (or logos above ~2 MB) — package/build impact if `sharp` is
added later (native binary, Netlify function size, cold start).

## Production safety confirms

| Check | Status |
|---|---|
| production database changed | **NO** |
| production Storage changed | **NO** |
| existing CI image URLs changed | **NO** |
| Squarespace assets deleted | **NO** |
| existing heroes/logos replaced | **NO** |
| SUPABASE_DEV_* configured | **NO** (stop after implementation + fixtures) |
