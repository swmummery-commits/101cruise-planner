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

Production `--rollback` remains **blocked** (broad Original restore not enabled).

Production `--copy` is allowed only with a narrow Princess Cruises gate
(`--line-id` + `--confirm-production-copy=PRINCESS`). It uploads to
`cruise-media` and writes `media_library` only — never changes `logo_url` /
`hero_image_url`.

Production `--promote` is allowed only for the same Princess line with
`--confirm-production-promote=PRINCESS`. It patches **exactly two** CI fields
(Princess `logo_url` + Crown Princess `hero_image_url`) after validating the
two Media Library records. No upload, no `media_library` insert, no Storage
delete. Atomic all-or-nothing with a pre-written rollback manifest.

```bash
# DEV dry run
node scripts/migrate-squarespace-ci-media.mjs --dry-run --target=dev

# Production dry run (read-only inspection; zero DB/Storage writes)
node scripts/migrate-squarespace-ci-media.mjs --dry-run --target=production

# Scoped production dry run
node scripts/migrate-squarespace-ci-media.mjs --dry-run --target=production --line-id <uuid>
node scripts/migrate-squarespace-ci-media.mjs --dry-run --target=production --logos-only

# DEV copy / promote / rollback
node scripts/migrate-squarespace-ci-media.mjs --copy --target=dev --line-id <uuid>
node scripts/migrate-squarespace-ci-media.mjs --promote --target=dev --from-copy tmp/squarespace-migration/copy-….json
node scripts/migrate-squarespace-ci-media.mjs --rollback --target=dev --manifest tmp/squarespace-migration/rollback-manifest-….json

# Gated Original-project COPY (Princess only)
node scripts/migrate-squarespace-ci-media.mjs \
  --copy \
  --target=production \
  --line-id c19f40a7-c160-4035-a845-14dada550e1f \
  --confirm-production-copy=PRINCESS

# Gated Original-project PROMOTE (Princess logo + Crown Princess hero only)
node scripts/migrate-squarespace-ci-media.mjs \
  --promote \
  --target=production \
  --line-id c19f40a7-c160-4035-a845-14dada550e1f \
  --confirm-production-promote=PRINCESS
```

Scopes: `--line-id`, `--ship-id`, `--ids a,b`, `--logos-only`, `--ships-only`, `--all-hosts` (default is Squarespace-only).

## Two-phase behaviour

1. **COPY** — download → hash → dedupe → upload `cruise-media` → insert/reuse `media_library` → verify public URL. **CI URLs unchanged.** (DEV freely; Original gated.)
2. **PROMOTE** — after explicit approval; patches `logo_url` / `hero_image_url` to verified Supabase URLs; writes rollback manifest. (DEV freely; Original gated for Princess only.)

Rollback restores CI URLs only. Never deletes Squarespace or Supabase objects.
Broad Original-project rollback is **not** enabled; the promote manifest records
a future guarded restore command for separate approval.

## Paths

- Logos: `cruise-media/lines/{line_id}/{hash12}-{safeFilename}`
- Ships: `cruise-media/ships/{ship_id}/{hash12}-{safeFilename}` (same as 16D)

`import_source = squarespace_ci_migration`

## Tests

```bash
node scripts/test-squarespace-ci-media.mjs
node scripts/test-squarespace-target.mjs
node scripts/test-squarespace-production-promote.mjs
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
| production copy | **gated** (Princess + confirm token; media_library + cruise-media) |
| production promote | **gated** (Princess + confirm token; exactly two CI URL fields; atomic) |
| CI `logo_url` / `hero_image_url` on copy | **unchanged** |
| Squarespace assets deleted | **NO** |
| target inferred from env presence | **NO** — `--target` required |
