# External Brand Imaging ship-image audit & hero upload

Read-only inventory and controlled production hero uploads from an external
drive Brand Imaging library.

## Audit (no writes)

```bash
node scripts/audit-external-ship-images.mjs \
  --target=production \
  --root="/Volumes/4T My Music for Mac 4TB/BRAND IMAGING"
```

Writes gitignored manifests under `tmp/ship-image-audit-external/`.

## Strict hero batch 1 upload

Dry run:

```bash
node scripts/upload-external-ship-heroes-batch-1.mjs \
  --dry-run --target=production \
  --confirm=UPLOAD-EXTERNAL-SHIP-HEROES-BATCH-1
```

Apply (Original project only):

```bash
node scripts/upload-external-ship-heroes-batch-1.mjs \
  --apply --target=production \
  --confirm=UPLOAD-EXTERNAL-SHIP-HEROES-BATCH-1
```

### Hard exclusions

- Steve-selection multi-candidate ships
- Scenic Eclipse II identity risk
- Disney / Rotterdam / Regent Explorer ambiguities
- Unmatched / ownership-conflict folders
- Existing canonical heroes (never overwritten)
- Galleries, cruise-line loose Hero Images, room-type images
- Filenames branded as a different vessel / CGI / deck-only scenes

Rollback evidence (gitignored):

- `tmp/ship-image-audit-external/hero-upload-batch-1-rollback.json`
- `tmp/ship-image-audit-external/hero-upload-batch-1-results.json`
