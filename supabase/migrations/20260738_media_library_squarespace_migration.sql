-- Sprint 16E — Squarespace CI media migration support (additive).
-- Unapplied draft until approved. Safe to re-run.
-- Extends Sprint 16D media_library columns; does not alter existing row meaning.

-- Original remote URL (Squarespace or other) for rollback / provenance.
ALTER TABLE public.media_library
  ADD COLUMN IF NOT EXISTS source_url text;

COMMENT ON COLUMN public.media_library.source_url IS
  'Original remote URL before copy into cruise-media (e.g. Squarespace CDN).';

-- Allow cruise-line logo assets in Media Library (paths: lines/{line_id}/…).
ALTER TABLE public.media_library
  DROP CONSTRAINT IF EXISTS media_library_type_check;

ALTER TABLE public.media_library
  ADD CONSTRAINT media_library_type_check
  CHECK (media_type IN (
    'ship',
    'destination',
    'port',
    'route_map',
    'general',
    'cruise_line'
  ));

-- Idempotent dedupe for cruise-line logos by binary hash.
CREATE UNIQUE INDEX IF NOT EXISTS media_library_line_content_hash_uidx
  ON public.media_library (cruise_line_id, content_hash)
  WHERE cruise_line_id IS NOT NULL
    AND content_hash IS NOT NULL
    AND length(trim(content_hash)) > 0;

CREATE INDEX IF NOT EXISTS media_library_source_url_idx
  ON public.media_library (source_url)
  WHERE source_url IS NOT NULL;
