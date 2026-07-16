-- Sprint 7D: Cruise Intelligence catalogue (Base44 → Supabase)
--
-- IMPORTANT: public.cruise_lines (bigint) and public.ships already exist for the
-- Drinks Calculator / simple planner logos. This migration creates separate
-- UUID tables for the permanent cruise-line and ship knowledge base:
--   public.ci_cruise_lines
--   public.ci_cruise_ships
--
-- Idempotent. Does not import itineraries, prices, or availability.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.set_ci_cruise_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = timezone('utc', now());
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Cruise lines
-- ---------------------------------------------------------------------------

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
  public_visible boolean NOT NULL DEFAULT false,
  excluded_reason text,
  needs_review boolean NOT NULL DEFAULT false,
  review_notes text,
  display_order integer NOT NULL DEFAULT 100,
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
  ON public.ci_cruise_lines (public_visible, active, sold_by_101cruise, display_order);

CREATE INDEX IF NOT EXISTS ci_cruise_lines_sold_idx
  ON public.ci_cruise_lines (sold_by_101cruise, active);

DROP TRIGGER IF EXISTS ci_cruise_lines_set_updated_at ON public.ci_cruise_lines;
CREATE TRIGGER ci_cruise_lines_set_updated_at
  BEFORE UPDATE ON public.ci_cruise_lines
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_ci_cruise_updated_at();

COMMENT ON TABLE public.ci_cruise_lines IS
  'Cruise Intelligence catalogue of cruise lines. Separate from drinks-calculator public.cruise_lines.';

-- ---------------------------------------------------------------------------
-- Cruise ships
-- ---------------------------------------------------------------------------

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
  public_visible boolean NOT NULL DEFAULT false,
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
  ON public.ci_cruise_ships (cruise_line_id, active, public_visible);

CREATE INDEX IF NOT EXISTS ci_cruise_ships_status_idx
  ON public.ci_cruise_ships (status);

CREATE INDEX IF NOT EXISTS ci_cruise_ships_name_trgm_ready_idx
  ON public.ci_cruise_ships (lower(name));

DROP TRIGGER IF EXISTS ci_cruise_ships_set_updated_at ON public.ci_cruise_ships;
CREATE TRIGGER ci_cruise_ships_set_updated_at
  BEFORE UPDATE ON public.ci_cruise_ships
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_ci_cruise_updated_at();

COMMENT ON TABLE public.ci_cruise_ships IS
  'Cruise Intelligence catalogue of ships. Itineraries are never stored here.';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE public.ci_cruise_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ci_cruise_ships ENABLE ROW LEVEL SECURITY;

-- Public read: active + public_visible (+ sold_by_101cruise for lines)
DROP POLICY IF EXISTS "Public can read visible cruise intelligence lines"
  ON public.ci_cruise_lines;
CREATE POLICY "Public can read visible cruise intelligence lines"
  ON public.ci_cruise_lines
  FOR SELECT
  TO anon, authenticated
  USING (
    active = true
    AND public_visible = true
    AND sold_by_101cruise = true
    AND excluded_reason IS NULL
  );

DROP POLICY IF EXISTS "Admins can select cruise intelligence lines"
  ON public.ci_cruise_lines;
CREATE POLICY "Admins can select cruise intelligence lines"
  ON public.ci_cruise_lines
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can insert cruise intelligence lines"
  ON public.ci_cruise_lines;
CREATE POLICY "Admins can insert cruise intelligence lines"
  ON public.ci_cruise_lines
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can update cruise intelligence lines"
  ON public.ci_cruise_lines;
CREATE POLICY "Admins can update cruise intelligence lines"
  ON public.ci_cruise_lines
  FOR UPDATE
  TO authenticated
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

DROP POLICY IF EXISTS "Admins can delete cruise intelligence lines"
  ON public.ci_cruise_lines;
CREATE POLICY "Admins can delete cruise intelligence lines"
  ON public.ci_cruise_lines
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

-- Ships: public only when ship is visible/active AND parent line is sold + visible + active
DROP POLICY IF EXISTS "Public can read visible cruise intelligence ships"
  ON public.ci_cruise_ships;
CREATE POLICY "Public can read visible cruise intelligence ships"
  ON public.ci_cruise_ships
  FOR SELECT
  TO anon, authenticated
  USING (
    active = true
    AND public_visible = true
    AND EXISTS (
      SELECT 1
      FROM public.ci_cruise_lines cl
      WHERE cl.id = ci_cruise_ships.cruise_line_id
        AND cl.active = true
        AND cl.public_visible = true
        AND cl.sold_by_101cruise = true
        AND cl.excluded_reason IS NULL
    )
  );

DROP POLICY IF EXISTS "Admins can select cruise intelligence ships"
  ON public.ci_cruise_ships;
CREATE POLICY "Admins can select cruise intelligence ships"
  ON public.ci_cruise_ships
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can insert cruise intelligence ships"
  ON public.ci_cruise_ships;
CREATE POLICY "Admins can insert cruise intelligence ships"
  ON public.ci_cruise_ships
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can update cruise intelligence ships"
  ON public.ci_cruise_ships;
CREATE POLICY "Admins can update cruise intelligence ships"
  ON public.ci_cruise_ships
  FOR UPDATE
  TO authenticated
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

DROP POLICY IF EXISTS "Admins can delete cruise intelligence ships"
  ON public.ci_cruise_ships;
CREATE POLICY "Admins can delete cruise intelligence ships"
  ON public.ci_cruise_ships
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

-- Grant table access (RLS still applies)
GRANT SELECT ON public.ci_cruise_lines TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ci_cruise_lines TO authenticated;
GRANT SELECT ON public.ci_cruise_ships TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ci_cruise_ships TO authenticated;
