-- Port Image Finder: port-specific imagery metadata on canonical ports catalogue.
-- Idempotent. Admin-only RLS unchanged on public.ports.

ALTER TABLE public.ports
  ADD COLUMN IF NOT EXISTS hero_media_id uuid NULL REFERENCES public.media_library(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS image_status text NULL,
  ADD COLUMN IF NOT EXISTS image_source text NULL,
  ADD COLUMN IF NOT EXISTS image_source_url text NULL,
  ADD COLUMN IF NOT EXISTS image_credit text NULL,
  ADD COLUMN IF NOT EXISTS image_license text NULL,
  ADD COLUMN IF NOT EXISTS image_search_query text NULL,
  ADD COLUMN IF NOT EXISTS image_confidence numeric NULL,
  ADD COLUMN IF NOT EXISTS image_last_checked_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS image_candidates jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ports_image_status_check'
  ) THEN
    ALTER TABLE public.ports
      ADD CONSTRAINT ports_image_status_check
      CHECK (
        image_status IS NULL
        OR image_status IN ('MANUAL', 'AUTO_APPROVED', 'NEEDS_REVIEW', 'NO_IMAGE')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ports_image_confidence_range'
  ) THEN
    ALTER TABLE public.ports
      ADD CONSTRAINT ports_image_confidence_range
      CHECK (image_confidence IS NULL OR (image_confidence >= 0 AND image_confidence <= 100));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ports_image_candidates_is_array'
  ) THEN
    ALTER TABLE public.ports
      ADD CONSTRAINT ports_image_candidates_is_array
      CHECK (jsonb_typeof(image_candidates) = 'array');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ports_hero_media_idx
  ON public.ports (hero_media_id)
  WHERE hero_media_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ports_image_status_idx
  ON public.ports (image_status)
  WHERE image_status IS NOT NULL;

CREATE INDEX IF NOT EXISTS ports_image_last_checked_idx
  ON public.ports (image_last_checked_at)
  WHERE image_last_checked_at IS NOT NULL;

COMMENT ON COLUMN public.ports.hero_media_id IS
  'Preferred port hero from media_library (media_type=port). Used by Explore pages when destination_ports has no override.';
COMMENT ON COLUMN public.ports.image_status IS
  'MANUAL | AUTO_APPROVED | NEEDS_REVIEW | NO_IMAGE — manual selections are never overwritten by automation.';
COMMENT ON COLUMN public.ports.image_source IS
  'Image provenance provider: manual, wikimedia, pexels, brave, etc.';
COMMENT ON COLUMN public.ports.image_candidates IS
  'Cached image search shortlist for admin review (JSON array).';
