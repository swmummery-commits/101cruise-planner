-- Sprint 11D: Cruise Discovery Engine
-- Official-source cruise catalogue + discovery runs + review queue.
-- Safe to re-run. Never permanently deletes discovered cruises.
--
-- IMPORTANT: public.cruises is already used by the customer Planner
-- (user sailings). Discovery uses public.discovered_cruises instead.
--
-- Prerequisite: public.destinations (Sprint 11C). If missing, this migration
-- creates a minimal destinations shell so Discovery can install.

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
-- 0. Destinations shell (Sprint 11C) — only if not already present
-- =========================================================

CREATE TABLE IF NOT EXISTS public.destinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  hero_media_id uuid NULL,
  research_content_id uuid NULL,
  primary_region text NULL,
  display_order integer NOT NULL DEFAULT 100,
  seo_title text NULL,
  meta_description text NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT destinations_name_not_blank CHECK (length(trim(name)) > 0),
  CONSTRAINT destinations_slug_not_blank CHECK (length(trim(slug)) > 0),
  CONSTRAINT destinations_status_check CHECK (status IN ('draft', 'published', 'hidden'))
);

CREATE UNIQUE INDEX IF NOT EXISTS destinations_slug_uidx
  ON public.destinations (lower(slug));

CREATE INDEX IF NOT EXISTS destinations_status_order_idx
  ON public.destinations (status, display_order, name);

DROP TRIGGER IF EXISTS destinations_set_updated_at ON public.destinations;
CREATE TRIGGER destinations_set_updated_at
  BEFORE UPDATE ON public.destinations
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at_timestamp();

ALTER TABLE public.destinations ENABLE ROW LEVEL SECURITY;

-- =========================================================
-- 1. Cruise line / ship field enhancements
-- =========================================================

ALTER TABLE public.ci_cruise_lines
  ADD COLUMN IF NOT EXISTS cruise_search_url text;

COMMENT ON COLUMN public.ci_cruise_lines.cruise_search_url IS
  'Official cruise search / find-a-cruise URL for Discovery Engine seeding.';

ALTER TABLE public.ci_cruise_ships
  ADD COLUMN IF NOT EXISTS official_line_ship_id text;

COMMENT ON COLUMN public.ci_cruise_ships.official_line_ship_id IS
  'Cruise line''s own ship identifier when available from official sources.';

COMMENT ON COLUMN public.ci_cruise_ships.official_ship_url IS
  'Canonical official ship page URL. Strategic reference for deck plans, media, and research.';

-- =========================================================
-- 2. Discovered cruises catalogue (Discovery Engine source of truth)
-- =========================================================

CREATE TABLE IF NOT EXISTS public.discovered_cruises (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cruise_line_id uuid NOT NULL REFERENCES public.ci_cruise_lines(id) ON DELETE RESTRICT,
  ship_id uuid NULL REFERENCES public.ci_cruise_ships(id) ON DELETE SET NULL,
  destination_id uuid NULL REFERENCES public.destinations(id) ON DELETE SET NULL,
  departure_date date NULL,
  return_date date NULL,
  nights integer NULL,
  departure_port text NULL,
  itinerary text NULL,
  itinerary_ports jsonb NOT NULL DEFAULT '[]'::jsonb,
  brochure_fare numeric NULL,
  currency text NULL,
  brochure_fare_display text NULL,
  official_url text NOT NULL,
  source_url text NULL,
  external_key text NOT NULL,
  status text NOT NULL DEFAULT 'review_required',
  match_confidence text NULL,
  review_reason text NULL,
  raw_extract jsonb NOT NULL DEFAULT '{}'::jsonb,
  discovered_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  last_seen_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  last_verified_at timestamptz NULL,
  last_changed_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),

  CONSTRAINT discovered_cruises_status_check CHECK (
    status IN ('active', 'expired', 'hidden', 'review_required')
  ),
  CONSTRAINT discovered_cruises_confidence_check CHECK (
    match_confidence IS NULL
    OR match_confidence IN ('high', 'medium', 'low')
  ),
  CONSTRAINT discovered_cruises_official_url_not_blank CHECK (length(trim(official_url)) > 0),
  CONSTRAINT discovered_cruises_external_key_not_blank CHECK (length(trim(external_key)) > 0),
  CONSTRAINT discovered_cruises_nights_positive CHECK (nights IS NULL OR nights > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS discovered_cruises_external_key_uidx
  ON public.discovered_cruises (external_key);

CREATE INDEX IF NOT EXISTS discovered_cruises_destination_active_idx
  ON public.discovered_cruises (destination_id, status, departure_date)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS discovered_cruises_line_status_idx
  ON public.discovered_cruises (cruise_line_id, status, departure_date);

CREATE INDEX IF NOT EXISTS discovered_cruises_ship_idx
  ON public.discovered_cruises (ship_id)
  WHERE ship_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS discovered_cruises_departure_month_idx
  ON public.discovered_cruises (date_trunc('month', departure_date::timestamp))
  WHERE departure_date IS NOT NULL;

CREATE OR REPLACE FUNCTION public.set_discovered_cruises_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = timezone('utc', now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS discovered_cruises_set_updated_at ON public.discovered_cruises;
CREATE TRIGGER discovered_cruises_set_updated_at
  BEFORE UPDATE ON public.discovered_cruises
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_discovered_cruises_updated_at();

COMMENT ON TABLE public.discovered_cruises IS
  'Cruise Discovery Engine catalogue. Official-source sailings only; never invent prices or itineraries. Separate from planner public.cruises.';

ALTER TABLE public.discovered_cruises ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can read active discovered cruises" ON public.discovered_cruises;
CREATE POLICY "Public can read active discovered cruises"
  ON public.discovered_cruises
  FOR SELECT
  TO anon, authenticated
  USING (status = 'active');

DROP POLICY IF EXISTS "Admins can read all discovered cruises" ON public.discovered_cruises;
CREATE POLICY "Admins can read all discovered cruises"
  ON public.discovered_cruises
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.is_admin = true
    )
  );

-- =========================================================
-- 3. Discovery runs
-- =========================================================

CREATE TABLE IF NOT EXISTS public.cruise_discovery_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL DEFAULT 'full',
  cruise_line_id uuid NULL REFERENCES public.ci_cruise_lines(id) ON DELETE SET NULL,
  destination_id uuid NULL REFERENCES public.destinations(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'queued',
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text NULL,
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),

  CONSTRAINT cruise_discovery_runs_scope_check CHECK (
    scope IN ('full', 'cruise_line', 'destination')
  ),
  CONSTRAINT cruise_discovery_runs_status_check CHECK (
    status IN ('queued', 'running', 'completed', 'failed', 'cancelled')
  )
);

CREATE INDEX IF NOT EXISTS cruise_discovery_runs_created_idx
  ON public.cruise_discovery_runs (created_at DESC);

CREATE INDEX IF NOT EXISTS cruise_discovery_runs_status_idx
  ON public.cruise_discovery_runs (status, created_at DESC);

CREATE OR REPLACE FUNCTION public.set_cruise_discovery_runs_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = timezone('utc', now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cruise_discovery_runs_set_updated_at ON public.cruise_discovery_runs;
CREATE TRIGGER cruise_discovery_runs_set_updated_at
  BEFORE UPDATE ON public.cruise_discovery_runs
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_cruise_discovery_runs_updated_at();

ALTER TABLE public.cruise_discovery_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read discovery runs" ON public.cruise_discovery_runs;
CREATE POLICY "Admins can read discovery runs"
  ON public.cruise_discovery_runs
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.is_admin = true
    )
  );

-- =========================================================
-- 4. Review queue
-- =========================================================

CREATE TABLE IF NOT EXISTS public.cruise_discovery_review_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NULL REFERENCES public.cruise_discovery_runs(id) ON DELETE SET NULL,
  cruise_id uuid NULL REFERENCES public.discovered_cruises(id) ON DELETE SET NULL,
  cruise_line_id uuid NULL REFERENCES public.ci_cruise_lines(id) ON DELETE SET NULL,
  destination_id uuid NULL REFERENCES public.destinations(id) ON DELETE SET NULL,
  item_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  title text NULL,
  detail text NULL,
  source_url text NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  resolved_at timestamptz NULL,
  resolved_by uuid NULL,

  CONSTRAINT cruise_discovery_review_item_type_check CHECK (
    item_type IN (
      'unknown_ship',
      'unknown_destination',
      'validation_failure',
      'missing_url',
      'missing_ship_url',
      'changed_price',
      'other'
    )
  ),
  CONSTRAINT cruise_discovery_review_status_check CHECK (
    status IN ('pending', 'resolved', 'ignored')
  )
);

CREATE INDEX IF NOT EXISTS cruise_discovery_review_pending_idx
  ON public.cruise_discovery_review_items (status, created_at DESC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS cruise_discovery_review_run_idx
  ON public.cruise_discovery_review_items (run_id);

ALTER TABLE public.cruise_discovery_review_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read discovery review items" ON public.cruise_discovery_review_items;
CREATE POLICY "Admins can read discovery review items"
  ON public.cruise_discovery_review_items
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.is_admin = true
    )
  );

COMMENT ON TABLE public.cruise_discovery_review_items IS
  'Manual review queue for Discovery Engine: unknown ships/destinations, validation failures, missing URLs.';
