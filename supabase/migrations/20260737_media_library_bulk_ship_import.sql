-- Sprint 16D — Bulk ship image import support (additive).
-- Unapplied draft until approved. Safe to re-run.
-- Does not alter existing media_library rows' meaning; adds columns only.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Staging bucket for admin ZIP uploads (private). Service-role only.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'media-imports',
  'media-imports',
  false,
  52428800,
  ARRAY[
    'application/zip',
    'application/x-zip-compressed',
    'application/octet-stream'
  ]::text[]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- No public read policy — imports are admin/service-role only.

ALTER TABLE public.media_library
  ADD COLUMN IF NOT EXISTS content_hash text,
  ADD COLUMN IF NOT EXISTS import_source text,
  ADD COLUMN IF NOT EXISTS original_filename text;

COMMENT ON COLUMN public.media_library.content_hash IS
  'SHA-256 hex of file bytes for idempotent bulk import dedupe.';
COMMENT ON COLUMN public.media_library.import_source IS
  'Provenance tag, e.g. bulk_ship_zip_single_line.';
COMMENT ON COLUMN public.media_library.original_filename IS
  'Original filename from import ZIP (sanitised copy also in file_name / path).';

CREATE UNIQUE INDEX IF NOT EXISTS media_library_ship_content_hash_uidx
  ON public.media_library (ship_id, content_hash)
  WHERE ship_id IS NOT NULL
    AND content_hash IS NOT NULL
    AND length(trim(content_hash)) > 0;

CREATE INDEX IF NOT EXISTS media_library_content_hash_idx
  ON public.media_library (content_hash)
  WHERE content_hash IS NOT NULL;
