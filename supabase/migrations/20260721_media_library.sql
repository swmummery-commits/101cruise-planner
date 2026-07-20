-- Sprint 10C: Shared Media Library + Featured Cruise media references.
-- Additive only. Safe to re-run.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.set_updated_at_timestamp()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = timezone('utc', now());
  RETURN NEW;
END;
$$;

-- =========================================================
-- Storage bucket: cruise-media
-- =========================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'cruise-media',
  'cruise-media',
  true,
  10485760,
  ARRAY['image/png', 'image/webp', 'image/jpeg', 'image/jpg']::text[]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Public read cruise-media" ON storage.objects;
CREATE POLICY "Public read cruise-media"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'cruise-media');

-- Uploads/deletes go through Admin-authenticated Netlify signed URLs (service role).
-- No anon INSERT/UPDATE/DELETE on storage.objects for this bucket.

-- =========================================================
-- media_library
-- =========================================================

CREATE TABLE IF NOT EXISTS public.media_library (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  alt_text text NULL,
  media_type text NOT NULL DEFAULT 'general',
  storage_bucket text NOT NULL DEFAULT 'cruise-media',
  storage_path text NOT NULL,
  public_url text NOT NULL,
  file_name text NULL,
  mime_type text NULL,
  width integer NULL,
  height integer NULL,
  file_size_bytes bigint NULL,
  cruise_line_id uuid NULL REFERENCES public.ci_cruise_lines(id) ON DELETE SET NULL,
  ship_id uuid NULL REFERENCES public.ci_cruise_ships(id) ON DELETE SET NULL,
  destination_name text NULL,
  port_name text NULL,
  tags text[] NOT NULL DEFAULT '{}'::text[],
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT media_library_type_check
    CHECK (media_type IN ('ship', 'destination', 'port', 'route_map', 'general')),
  CONSTRAINT media_library_title_not_blank
    CHECK (length(trim(title)) > 0),
  CONSTRAINT media_library_dims_check
    CHECK (
      (width IS NULL OR width > 0)
      AND (height IS NULL OR height > 0)
      AND (file_size_bytes IS NULL OR file_size_bytes >= 0)
    )
);

CREATE INDEX IF NOT EXISTS media_library_type_active_idx
  ON public.media_library (media_type, is_active);

CREATE INDEX IF NOT EXISTS media_library_ship_idx
  ON public.media_library (ship_id)
  WHERE ship_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS media_library_line_idx
  ON public.media_library (cruise_line_id)
  WHERE cruise_line_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS media_library_destination_ci_idx
  ON public.media_library (lower(trim(destination_name)))
  WHERE destination_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS media_library_default_ship_idx
  ON public.media_library (ship_id, media_type)
  WHERE is_default = true AND ship_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS media_library_default_destination_idx
  ON public.media_library (lower(trim(destination_name)), media_type)
  WHERE is_default = true AND destination_name IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS media_library_storage_path_uidx
  ON public.media_library (storage_bucket, storage_path);

DROP TRIGGER IF EXISTS media_library_set_updated_at ON public.media_library;
CREATE TRIGGER media_library_set_updated_at
  BEFORE UPDATE ON public.media_library
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at_timestamp();

ALTER TABLE public.media_library ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can select media_library" ON public.media_library;
CREATE POLICY "Admins can select media_library"
  ON public.media_library FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can insert media_library" ON public.media_library;
CREATE POLICY "Admins can insert media_library"
  ON public.media_library FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can update media_library" ON public.media_library;
CREATE POLICY "Admins can update media_library"
  ON public.media_library FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can delete media_library" ON public.media_library;
CREATE POLICY "Admins can delete media_library"
  ON public.media_library FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

COMMENT ON TABLE public.media_library IS
  'Shared Admin media library for ships, destinations, ports, route maps and general cruise imagery.';

-- =========================================================
-- featured_cruises media references (legacy URL fields retained)
-- =========================================================

ALTER TABLE public.featured_cruises
  ADD COLUMN IF NOT EXISTS hero_media_id uuid NULL REFERENCES public.media_library(id) ON DELETE SET NULL;

ALTER TABLE public.featured_cruises
  ADD COLUMN IF NOT EXISTS route_map_media_id uuid NULL REFERENCES public.media_library(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS featured_cruises_hero_media_idx
  ON public.featured_cruises (hero_media_id)
  WHERE hero_media_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS featured_cruises_route_map_media_idx
  ON public.featured_cruises (route_map_media_id)
  WHERE route_map_media_id IS NOT NULL;

COMMENT ON COLUMN public.featured_cruises.hero_media_id IS
  'Preferred hero image from media_library. Falls back to hero_image_url / ship defaults.';
COMMENT ON COLUMN public.featured_cruises.route_map_media_id IS
  'Preferred route map from media_library. Falls back to route_map_image_url.';
