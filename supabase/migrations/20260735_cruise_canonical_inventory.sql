-- DRAFT / UNAPPLIED — Sprint 15C Canonical Cruise Inventory storage.
-- HOLD DEPLOY. DO NOT RUN until migration review is complete.
-- Does NOT activate Engine V2. Does NOT store provider prices.
-- Finder V1 and customer UI remain untouched.
--
-- RLS planning notes:
--   - Admin read/write via profiles.is_admin (same pattern as ports / featured_cruises).
--   - Future public Finder read should use a dedicated Netlify service-role path or
--     a narrow SELECT policy on active sailings only — not added here yet.
--   - No anon INSERT/UPDATE on inventory tables.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =========================================================
-- 1. cruise_sailings — provider-independent canonical sailings
-- =========================================================

CREATE TABLE IF NOT EXISTS public.cruise_sailings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_key text NOT NULL,
  -- Must be Supabase ci_* UUIDs (resolve from legacy_base44_id at import time; CSV Base44 ids are not FKs).
  cruise_line_id uuid NULL REFERENCES public.ci_cruise_lines(id) ON DELETE SET NULL,
  ship_id uuid NULL REFERENCES public.ci_cruise_ships(id) ON DELETE SET NULL,
  title text NULL,
  departure_date date NOT NULL,
  return_date date NULL,
  nights integer NULL,
  departure_port_id uuid NULL REFERENCES public.ports(id) ON DELETE SET NULL,
  arrival_port_id uuid NULL REFERENCES public.ports(id) ON DELETE SET NULL,
  destinations jsonb NOT NULL DEFAULT '[]'::jsonb,
  route_object_eligible boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active',
  first_discovered_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  last_seen_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  retired_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT cruise_sailings_canonical_key_not_blank CHECK (length(trim(canonical_key)) > 0),
  CONSTRAINT cruise_sailings_nights_range CHECK (nights IS NULL OR (nights >= 1 AND nights <= 400)),
  CONSTRAINT cruise_sailings_status_check CHECK (status IN ('active', 'retired', 'needs_review')),
  CONSTRAINT cruise_sailings_destinations_is_array CHECK (jsonb_typeof(destinations) = 'array')
);

COMMENT ON TABLE public.cruise_sailings IS
  'Provider-independent canonical sailings for Engine V2 Finder inventory. No fare columns.';
COMMENT ON COLUMN public.cruise_sailings.canonical_key IS
  'Stable identity: cruise_line_id|ship_id|departure_date|nights|departure_port_id (see docs).';

CREATE UNIQUE INDEX IF NOT EXISTS cruise_sailings_canonical_key_uidx
  ON public.cruise_sailings (canonical_key);

CREATE INDEX IF NOT EXISTS cruise_sailings_departure_date_idx
  ON public.cruise_sailings (departure_date);

CREATE INDEX IF NOT EXISTS cruise_sailings_line_ship_idx
  ON public.cruise_sailings (cruise_line_id, ship_id);

CREATE INDEX IF NOT EXISTS cruise_sailings_dep_port_idx
  ON public.cruise_sailings (departure_port_id);

CREATE INDEX IF NOT EXISTS cruise_sailings_active_dep_idx
  ON public.cruise_sailings (active, departure_date)
  WHERE active = true;

DROP TRIGGER IF EXISTS cruise_sailings_set_updated_at ON public.cruise_sailings;
CREATE TRIGGER cruise_sailings_set_updated_at
  BEFORE UPDATE ON public.cruise_sailings
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at_timestamp();

ALTER TABLE public.cruise_sailings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can select cruise_sailings" ON public.cruise_sailings;
CREATE POLICY "Admins can select cruise_sailings"
  ON public.cruise_sailings FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.is_admin = true));

DROP POLICY IF EXISTS "Admins can insert cruise_sailings" ON public.cruise_sailings;
CREATE POLICY "Admins can insert cruise_sailings"
  ON public.cruise_sailings FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.is_admin = true));

DROP POLICY IF EXISTS "Admins can update cruise_sailings" ON public.cruise_sailings;
CREATE POLICY "Admins can update cruise_sailings"
  ON public.cruise_sailings FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.is_admin = true));

DROP POLICY IF EXISTS "Admins can delete cruise_sailings" ON public.cruise_sailings;
CREATE POLICY "Admins can delete cruise_sailings"
  ON public.cruise_sailings FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.is_admin = true));

-- =========================================================
-- 2. cruise_sailing_itinerary
-- =========================================================

CREATE TABLE IF NOT EXISTS public.cruise_sailing_itinerary (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cruise_sailing_id uuid NOT NULL REFERENCES public.cruise_sailings(id) ON DELETE CASCADE,
  day_number integer NULL,
  itinerary_date date NULL,
  type text NOT NULL,
  port_id uuid NULL REFERENCES public.ports(id) ON DELETE SET NULL,
  provider_description text NULL,
  canonical_name text NULL,
  latitude numeric NULL,
  longitude numeric NULL,
  sequence integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT cruise_sailing_itinerary_type_check CHECK (
    type IN ('embarkation', 'port', 'scenic_cruising', 'sea', 'disembarkation')
  ),
  CONSTRAINT cruise_sailing_itinerary_sequence_positive CHECK (sequence >= 1),
  CONSTRAINT cruise_sailing_itinerary_lat_range CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90)),
  CONSTRAINT cruise_sailing_itinerary_lng_range CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180))
);

CREATE UNIQUE INDEX IF NOT EXISTS cruise_sailing_itinerary_sailing_seq_uidx
  ON public.cruise_sailing_itinerary (cruise_sailing_id, sequence);

CREATE INDEX IF NOT EXISTS cruise_sailing_itinerary_port_idx
  ON public.cruise_sailing_itinerary (port_id);

DROP TRIGGER IF EXISTS cruise_sailing_itinerary_set_updated_at ON public.cruise_sailing_itinerary;
CREATE TRIGGER cruise_sailing_itinerary_set_updated_at
  BEFORE UPDATE ON public.cruise_sailing_itinerary
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at_timestamp();

ALTER TABLE public.cruise_sailing_itinerary ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can select cruise_sailing_itinerary" ON public.cruise_sailing_itinerary;
CREATE POLICY "Admins can select cruise_sailing_itinerary"
  ON public.cruise_sailing_itinerary FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.is_admin = true));

DROP POLICY IF EXISTS "Admins can insert cruise_sailing_itinerary" ON public.cruise_sailing_itinerary;
CREATE POLICY "Admins can insert cruise_sailing_itinerary"
  ON public.cruise_sailing_itinerary FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.is_admin = true));

DROP POLICY IF EXISTS "Admins can update cruise_sailing_itinerary" ON public.cruise_sailing_itinerary;
CREATE POLICY "Admins can update cruise_sailing_itinerary"
  ON public.cruise_sailing_itinerary FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.is_admin = true));

DROP POLICY IF EXISTS "Admins can delete cruise_sailing_itinerary" ON public.cruise_sailing_itinerary;
CREATE POLICY "Admins can delete cruise_sailing_itinerary"
  ON public.cruise_sailing_itinerary FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.is_admin = true));

-- =========================================================
-- 3. cruise_sailing_sources — multi-provider lineage
-- =========================================================

CREATE TABLE IF NOT EXISTS public.cruise_sailing_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cruise_sailing_id uuid NOT NULL REFERENCES public.cruise_sailings(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_cruise_id text NOT NULL,
  provider_itinerary_id text NULL,
  source_url text NULL,
  provider_updated_at timestamptz NULL,
  first_seen_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  last_seen_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  raw_fingerprint text NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT cruise_sailing_sources_provider_not_blank CHECK (length(trim(provider)) > 0),
  CONSTRAINT cruise_sailing_sources_provider_cruise_id_not_blank CHECK (length(trim(provider_cruise_id)) > 0)
  -- NOTE: No price / fare columns by design.
);

COMMENT ON COLUMN public.cruise_sailing_sources.raw_fingerprint IS
  'Hash of price-stripped provider payload for change detection. Raw priced JSON must not be stored here.';

CREATE UNIQUE INDEX IF NOT EXISTS cruise_sailing_sources_provider_cruise_uidx
  ON public.cruise_sailing_sources (provider, provider_cruise_id);

CREATE INDEX IF NOT EXISTS cruise_sailing_sources_sailing_idx
  ON public.cruise_sailing_sources (cruise_sailing_id);

CREATE INDEX IF NOT EXISTS cruise_sailing_sources_active_idx
  ON public.cruise_sailing_sources (provider, active)
  WHERE active = true;

DROP TRIGGER IF EXISTS cruise_sailing_sources_set_updated_at ON public.cruise_sailing_sources;
CREATE TRIGGER cruise_sailing_sources_set_updated_at
  BEFORE UPDATE ON public.cruise_sailing_sources
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at_timestamp();

ALTER TABLE public.cruise_sailing_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can select cruise_sailing_sources" ON public.cruise_sailing_sources;
CREATE POLICY "Admins can select cruise_sailing_sources"
  ON public.cruise_sailing_sources FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.is_admin = true));

DROP POLICY IF EXISTS "Admins can insert cruise_sailing_sources" ON public.cruise_sailing_sources;
CREATE POLICY "Admins can insert cruise_sailing_sources"
  ON public.cruise_sailing_sources FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.is_admin = true));

DROP POLICY IF EXISTS "Admins can update cruise_sailing_sources" ON public.cruise_sailing_sources;
CREATE POLICY "Admins can update cruise_sailing_sources"
  ON public.cruise_sailing_sources FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.is_admin = true));

DROP POLICY IF EXISTS "Admins can delete cruise_sailing_sources" ON public.cruise_sailing_sources;
CREATE POLICY "Admins can delete cruise_sailing_sources"
  ON public.cruise_sailing_sources FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.is_admin = true));

-- =========================================================
-- 4. cruise_import_runs — sync audit
-- =========================================================

CREATE TABLE IF NOT EXISTS public.cruise_import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  completed_at timestamptz NULL,
  status text NOT NULL DEFAULT 'running',
  records_received integer NOT NULL DEFAULT 0,
  records_created integer NOT NULL DEFAULT 0,
  records_updated integer NOT NULL DEFAULT 0,
  records_unchanged integer NOT NULL DEFAULT 0,
  records_rejected integer NOT NULL DEFAULT 0,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  request_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT cruise_import_runs_status_check CHECK (
    status IN ('running', 'completed', 'failed', 'cancelled')
  ),
  CONSTRAINT cruise_import_runs_errors_is_array CHECK (jsonb_typeof(errors) = 'array')
);

CREATE INDEX IF NOT EXISTS cruise_import_runs_provider_started_idx
  ON public.cruise_import_runs (provider, started_at DESC);

ALTER TABLE public.cruise_import_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can select cruise_import_runs" ON public.cruise_import_runs;
CREATE POLICY "Admins can select cruise_import_runs"
  ON public.cruise_import_runs FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.is_admin = true));

DROP POLICY IF EXISTS "Admins can insert cruise_import_runs" ON public.cruise_import_runs;
CREATE POLICY "Admins can insert cruise_import_runs"
  ON public.cruise_import_runs FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.is_admin = true));

DROP POLICY IF EXISTS "Admins can update cruise_import_runs" ON public.cruise_import_runs;
CREATE POLICY "Admins can update cruise_import_runs"
  ON public.cruise_import_runs FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.is_admin = true));
