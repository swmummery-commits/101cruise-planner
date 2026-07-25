-- =============================================================================
-- DEV-ONLY curated bootstrap — Media migration integration environment
-- =============================================================================
-- Target project (manual SQL Editor only): vkheexbapykcdfbqcach
--
-- Purpose: Sprint 16D Bulk Ship Images + Sprint 16E Squarespace migration tests.
-- Location: supabase/dev-bootstrap/  (NOT supabase/migrations/)
--
-- DO NOT apply via production migration chain.
-- DO NOT run against production (xikbibxyinttllxamgao).
--
-- Independent of historic supabase/migrations ordering. Idempotent where practical.
-- Service-role scripts/Netlify functions are the intended writers (bypass RLS).
-- No public.profiles dependency.
-- No featured_cruises table (optional Media Library ↔ Featured FKs omitted).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Shared updated_at trigger helper
CREATE OR REPLACE FUNCTION public.set_updated_at_timestamp()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = timezone('utc', now());
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_ci_cruise_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = timezone('utc', now());
  RETURN NEW;
END;
$$;

-- =============================================================================
-- 1. ci_cruise_lines
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.ci_cruise_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_base44_id text UNIQUE,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  code text,
  country text,
  website_url text,
  description text,
  logo_url text,
  hero_image_url text,
  brand_colour text,
  line_type text,
  market_segment text,
  active boolean NOT NULL DEFAULT true,
  sold_by_101cruise boolean NOT NULL DEFAULT false,
  needs_review boolean NOT NULL DEFAULT false,
  review_notes text,
  source_name text,
  source_url text,
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),

  CONSTRAINT ci_cruise_lines_name_not_blank CHECK (length(trim(name)) > 0),
  CONSTRAINT ci_cruise_lines_slug_not_blank CHECK (length(trim(slug)) > 0),
  CONSTRAINT ci_cruise_lines_line_type_check CHECK (
    line_type IS NULL
    OR line_type IN ('ocean', 'river', 'expedition', 'yacht', 'specialty')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ci_cruise_lines_norm_name_uidx
  ON public.ci_cruise_lines (lower(trim(name)));

CREATE INDEX IF NOT EXISTS ci_cruise_lines_public_idx
  ON public.ci_cruise_lines (sold_by_101cruise, active, name);

DROP TRIGGER IF EXISTS ci_cruise_lines_set_updated_at ON public.ci_cruise_lines;
CREATE TRIGGER ci_cruise_lines_set_updated_at
  BEFORE UPDATE ON public.ci_cruise_lines
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_ci_cruise_updated_at();

COMMENT ON TABLE public.ci_cruise_lines IS
  'DEV bootstrap: Cruise Intelligence lines for media migration testing.';

-- =============================================================================
-- 2. ci_cruise_ships
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.ci_cruise_ships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cruise_line_id uuid NOT NULL REFERENCES public.ci_cruise_lines(id) ON DELETE RESTRICT,
  legacy_base44_id text UNIQUE,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  status text,
  ship_class text,
  year_built integer,
  year_refurbished integer,
  passenger_capacity integer,
  crew_count integer,
  deck_count integer,
  stateroom_count integer,
  gross_tonnage numeric,
  length_metres numeric,
  stateroom_breakdown jsonb,
  cabin_type_summary jsonb,
  facilities jsonb,
  hero_image_url text,
  image_gallery jsonb,
  deck_plan_url text,
  official_ship_url text,
  active boolean NOT NULL DEFAULT true,
  needs_review boolean NOT NULL DEFAULT false,
  review_notes text,
  source_name text,
  source_url text,
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),

  CONSTRAINT ci_cruise_ships_name_not_blank CHECK (length(trim(name)) > 0),
  CONSTRAINT ci_cruise_ships_slug_not_blank CHECK (length(trim(slug)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ci_cruise_ships_line_norm_name_uidx
  ON public.ci_cruise_ships (cruise_line_id, lower(trim(name)));

CREATE INDEX IF NOT EXISTS ci_cruise_ships_line_idx
  ON public.ci_cruise_ships (cruise_line_id, active);

CREATE INDEX IF NOT EXISTS ci_cruise_ships_status_idx
  ON public.ci_cruise_ships (status);

CREATE INDEX IF NOT EXISTS ci_cruise_ships_name_lower_idx
  ON public.ci_cruise_ships (lower(name));

DROP TRIGGER IF EXISTS ci_cruise_ships_set_updated_at ON public.ci_cruise_ships;
CREATE TRIGGER ci_cruise_ships_set_updated_at
  BEFORE UPDATE ON public.ci_cruise_ships
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_ci_cruise_updated_at();

COMMENT ON TABLE public.ci_cruise_ships IS
  'DEV bootstrap: Cruise Intelligence ships for media migration testing.';

-- =============================================================================
-- 3. cruise_ship_aliases (Bulk Ship Images matcher)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.cruise_ship_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ship_id uuid NOT NULL REFERENCES public.ci_cruise_ships(id) ON DELETE CASCADE,
  cruise_line_id uuid NOT NULL REFERENCES public.ci_cruise_lines(id) ON DELETE CASCADE,
  raw_alias text NOT NULL,
  normalised_alias text NOT NULL,
  source text NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT cruise_ship_aliases_raw_not_blank CHECK (length(trim(raw_alias)) > 0),
  CONSTRAINT cruise_ship_aliases_norm_not_blank CHECK (length(trim(normalised_alias)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS cruise_ship_aliases_line_norm_uidx
  ON public.cruise_ship_aliases (cruise_line_id, lower(normalised_alias))
  WHERE active = true;

CREATE INDEX IF NOT EXISTS cruise_ship_aliases_ship_idx
  ON public.cruise_ship_aliases (ship_id)
  WHERE active = true;

DROP TRIGGER IF EXISTS cruise_ship_aliases_set_updated_at ON public.cruise_ship_aliases;
CREATE TRIGGER cruise_ship_aliases_set_updated_at
  BEFORE UPDATE ON public.cruise_ship_aliases
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at_timestamp();

COMMENT ON TABLE public.cruise_ship_aliases IS
  'DEV bootstrap: line-scoped ship aliases for bulk ZIP folder matching.';

-- =============================================================================
-- 4. media_library (base + Sprint 16D/16E columns in one definition)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.media_library (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  alt_text text NULL,
  media_type text NOT NULL DEFAULT 'general',
  storage_bucket text NOT NULL DEFAULT 'cruise-media',
  storage_path text NOT NULL,
  public_url text NOT NULL,
  file_name text NULL,
  original_filename text NULL,
  mime_type text NULL,
  width integer NULL,
  height integer NULL,
  file_size_bytes bigint NULL,
  content_hash text NULL,
  import_source text NULL,
  source_url text NULL,
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
    CHECK (media_type IN (
      'ship',
      'destination',
      'port',
      'route_map',
      'general',
      'cruise_line'
    )),
  CONSTRAINT media_library_title_not_blank
    CHECK (length(trim(title)) > 0),
  CONSTRAINT media_library_dims_check
    CHECK (
      (width IS NULL OR width > 0)
      AND (height IS NULL OR height > 0)
      AND (file_size_bytes IS NULL OR file_size_bytes >= 0)
    )
);

-- Idempotent column adds if an older stub table already exists
ALTER TABLE public.media_library
  ADD COLUMN IF NOT EXISTS content_hash text,
  ADD COLUMN IF NOT EXISTS import_source text,
  ADD COLUMN IF NOT EXISTS original_filename text,
  ADD COLUMN IF NOT EXISTS source_url text;

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

CREATE UNIQUE INDEX IF NOT EXISTS media_library_ship_content_hash_uidx
  ON public.media_library (ship_id, content_hash)
  WHERE ship_id IS NOT NULL
    AND content_hash IS NOT NULL
    AND length(trim(content_hash)) > 0;

CREATE UNIQUE INDEX IF NOT EXISTS media_library_line_content_hash_uidx
  ON public.media_library (cruise_line_id, content_hash)
  WHERE cruise_line_id IS NOT NULL
    AND content_hash IS NOT NULL
    AND length(trim(content_hash)) > 0;

CREATE INDEX IF NOT EXISTS media_library_content_hash_idx
  ON public.media_library (content_hash)
  WHERE content_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS media_library_source_url_idx
  ON public.media_library (source_url)
  WHERE source_url IS NOT NULL;

DROP TRIGGER IF EXISTS media_library_set_updated_at ON public.media_library;
CREATE TRIGGER media_library_set_updated_at
  BEFORE UPDATE ON public.media_library
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at_timestamp();

COMMENT ON TABLE public.media_library IS
  'DEV bootstrap: Media Library with Sprint 16D/16E provenance columns.';
COMMENT ON COLUMN public.media_library.content_hash IS
  'SHA-256 hex of file bytes for idempotent import dedupe.';
COMMENT ON COLUMN public.media_library.import_source IS
  'Provenance tag, e.g. bulk_ship_zip_single_line or squarespace_ci_migration.';
COMMENT ON COLUMN public.media_library.original_filename IS
  'Original filename from ZIP or remote URL.';
COMMENT ON COLUMN public.media_library.source_url IS
  'Original remote URL before copy into cruise-media.';

-- =============================================================================
-- 5. Storage buckets
-- =============================================================================

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

-- Public read for cruise-media only (matches production Media Library architecture).
-- Uploads/deletes remain service-role / signed-upload (no anon write policies).
DROP POLICY IF EXISTS "Public read cruise-media" ON storage.objects;
CREATE POLICY "Public read cruise-media"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'cruise-media');

-- media-imports: private; no public SELECT policy (service-role only).

-- =============================================================================
-- 6. RLS (enabled; no profiles-based admin policies)
-- =============================================================================
-- Service role bypasses RLS — Netlify functions and migration scripts use it.
-- Public read mirrors production CI visibility rules (sold_by + active).

ALTER TABLE public.ci_cruise_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ci_cruise_ships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cruise_ship_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_library ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can read visible cruise intelligence lines"
  ON public.ci_cruise_lines;
CREATE POLICY "Public can read visible cruise intelligence lines"
  ON public.ci_cruise_lines
  FOR SELECT
  TO anon, authenticated
  USING (active = true AND sold_by_101cruise = true);

DROP POLICY IF EXISTS "Public can read visible cruise intelligence ships"
  ON public.ci_cruise_ships;
CREATE POLICY "Public can read visible cruise intelligence ships"
  ON public.ci_cruise_ships
  FOR SELECT
  TO anon, authenticated
  USING (
    active = true
    AND EXISTS (
      SELECT 1
      FROM public.ci_cruise_lines cl
      WHERE cl.id = ci_cruise_ships.cruise_line_id
        AND cl.active = true
        AND cl.sold_by_101cruise = true
    )
  );

-- Aliases and media_library: no anon/authenticated policies.
-- Access is via service_role (scripts + admin Netlify functions).

-- =============================================================================
-- 7. Grants (PostgREST exposure)
-- =============================================================================

GRANT SELECT ON public.ci_cruise_lines TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ci_cruise_lines TO authenticated;
GRANT ALL ON public.ci_cruise_lines TO service_role;

GRANT SELECT ON public.ci_cruise_ships TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ci_cruise_ships TO authenticated;
GRANT ALL ON public.ci_cruise_ships TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.cruise_ship_aliases TO authenticated;
GRANT ALL ON public.cruise_ship_aliases TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.media_library TO authenticated;
GRANT ALL ON public.media_library TO service_role;

-- =============================================================================
-- End DEV media bootstrap
-- =============================================================================
