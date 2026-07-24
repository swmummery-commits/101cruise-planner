# Sprint 16D — Bulk Ship Image Import

HOLD DEPLOY · DO NOT COMMIT · DO NOT PUSH (unless explicitly requested).

## 1. Existing architecture audit

Two image systems exist today:

| System | Bucket | DB | Used for |
|--------|--------|-----|----------|
| CI media upload | `ship-images`, `cruise-line-logos` | `ci_cruise_ships.hero_image_url`, `ci_cruise_lines.logo_url` | Admin CI form |
| Media Library | `cruise-media` | `media_library` (+ FKs to lines/ships) | Newsletter, destinations, reusable assets |

**Chosen path:** Media Library (`cruise-media` + `media_library`). Do not create a parallel system.

Gaps closed by additive migration `20260737_media_library_bulk_ship_import.sql` (unapplied):

- `content_hash` + unique `(ship_id, content_hash)` for idempotent dedupe
- `import_source`, `original_filename`
- Private staging bucket `media-imports` for ZIP uploads

## 2. Recommended import architecture

1. Admin selects cruise line + ZIP  
2. Client stages ZIP via signed upload → `media-imports/bulk-ship/{user}/{stamp}.zip`  
3. `dry_run` downloads ZIP server-side, matches folders to `ci_cruise_ships` (+ `cruise_ship_aliases`), hashes bytes, reports — **no catalogue writes**  
4. User confirms → `import` uploads to `cruise-media` and inserts `media_library` rows  
5. Hero files (`hero.jpg`, `primary.jpg`, …) tagged `suggested_hero` only — **never** auto-update `hero_image_url`  
6. Optional `apply_hero_suggestion` after explicit approval

## 3. Storage

| Purpose | Bucket | Path |
|---------|--------|------|
| ZIP staging | `media-imports` (private) | `bulk-ship/{adminUserId}/{stamp}-{rand}-{file}.zip` |
| Ship images | `cruise-media` (public) | `ships/{ship_id}/{sha256_12}-{safeFilename}` |

Content-addressed object paths + DB hash unique index ⇒ repeat imports create zero duplicates.

## 4. Database

- **Read:** `ci_cruise_lines`, `ci_cruise_ships`, `cruise_ship_aliases`
- **Write:** `media_library` only (plus optional explicit hero apply → `ci_cruise_ships.hero_image_url`)
- **Never:** auto-create lines/ships

## 5–6. Files

**Created**

- `supabase/migrations/20260737_media_library_bulk_ship_import.sql`
- `netlify/functions/bulk-ship-images.js`
- `netlify/functions/lib/bulk-ship-images/{matching,zip,plan,image-dims}.js`
- `js/admin-media-bulk-ship-images.js`
- `scripts/test-bulk-ship-images.mjs`
- `docs/sprint-16d-bulk-ship-images.md`

**Modified**

- `js/admin-media-library.js` — Library / Bulk Ship Images subtabs
- `js/admin.js` — load bulk module on Media Library tab
- `admin.html` — script tag
- `netlify.toml` — function timeout
- `package.json` — `jszip` dependency + test script

## 7–8. Dry-run / duplicate tests

Run (after `npm install` so `jszip` is available):

```bash
npm run test:bulk-ship-images
```

Offline fixture covers: multi-ship ZIP, exact + alias match, unmatched folder, unsupported PDF, `__MACOSX` / `.DS_Store`, hero suggestion, path traversal rejection, content-hash duplicate skip.

## 9. Setup / operating cost

| Item | Cost |
|------|------|
| Migration `20260737_…` | Must apply before production import (content_hash columns + media-imports bucket) |
| npm `jszip` | Required for Netlify function ZIP parse |
| `sharp` / EXIF strip / 2400px resize | **Not enabled** in v1 — originals stored (≤10 MB). Optional later |
| Netlify function timeout | 60s — large ZIPs may need batching later |
| Storage | Public `cruise-media` bandwidth as today |

## 10. Admin location

Marketing → Media Library → **Bulk Ship Images**

## Safety confirms

- database ownership of CI tables: unchanged (hero apply is explicit optional action only)
- Cruise Finder / inventory / research / audit: untouched
- existing heroes: never auto-replaced
- existing media rows: not modified by import (insert-only / dedupe skip)
