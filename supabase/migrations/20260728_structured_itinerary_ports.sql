-- Sprint 13D: Structured itinerary + canonical Ports foundation.
-- Idempotent. Admin-only RLS (profiles.is_admin), matching featured_cruise_* conventions.
-- Does NOT remove legacy itinerary_summary or featured_cruise_ports.
-- Does NOT generate route maps (Sprint 13E).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =========================================================
-- 1. Canonical ports catalogue
-- =========================================================

CREATE TABLE IF NOT EXISTS public.ports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name text NOT NULL,
  display_name text NULL,
  city text NULL,
  country text NULL,
  country_code text NULL,
  region text NULL,
  latitude numeric NULL,
  longitude numeric NULL,
  aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'provisional',
  source text NULL,
  source_url text NULL,
  source_featured_cruise_id uuid NULL REFERENCES public.featured_cruises(id) ON DELETE SET NULL,
  match_key text NULL,
  verified_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT ports_canonical_name_not_blank CHECK (length(trim(canonical_name)) > 0),
  CONSTRAINT ports_status_check CHECK (status IN ('verified', 'provisional', 'needs_review')),
  CONSTRAINT ports_aliases_is_array CHECK (jsonb_typeof(aliases) = 'array'),
  CONSTRAINT ports_lat_range CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90)),
  CONSTRAINT ports_lng_range CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180))
);

COMMENT ON TABLE public.ports IS
  'Canonical Ports catalogue for Featured Cruise itinerary matching and future route maps.';
COMMENT ON COLUMN public.ports.match_key IS
  'Normalised canonical_name|country key for duplicate-resistant matching. Application-maintained.';
COMMENT ON COLUMN public.ports.status IS
  'verified | provisional | needs_review';
COMMENT ON COLUMN public.ports.aliases IS
  'JSON array of alternate names used for autocomplete and matching.';

CREATE UNIQUE INDEX IF NOT EXISTS ports_match_key_uidx
  ON public.ports (match_key)
  WHERE match_key IS NOT NULL AND length(trim(match_key)) > 0;

CREATE INDEX IF NOT EXISTS ports_status_idx
  ON public.ports (status);

CREATE INDEX IF NOT EXISTS ports_canonical_name_lower_idx
  ON public.ports (lower(canonical_name));

CREATE INDEX IF NOT EXISTS ports_country_lower_idx
  ON public.ports (lower(country));

DROP TRIGGER IF EXISTS ports_set_updated_at ON public.ports;
CREATE TRIGGER ports_set_updated_at
  BEFORE UPDATE ON public.ports
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at_timestamp();

ALTER TABLE public.ports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can select ports" ON public.ports;
CREATE POLICY "Admins can select ports"
  ON public.ports
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can insert ports" ON public.ports;
CREATE POLICY "Admins can insert ports"
  ON public.ports
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can update ports" ON public.ports;
CREATE POLICY "Admins can update ports"
  ON public.ports
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

DROP POLICY IF EXISTS "Admins can delete ports" ON public.ports;
CREATE POLICY "Admins can delete ports"
  ON public.ports
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

-- =========================================================
-- 2. Featured cruise structured itinerary stops
-- =========================================================

CREATE TABLE IF NOT EXISTS public.featured_cruise_itinerary_stops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  featured_cruise_id uuid NOT NULL REFERENCES public.featured_cruises(id) ON DELETE CASCADE,
  display_order integer NOT NULL DEFAULT 1,
  day_number integer NULL,
  stop_date date NULL,
  stop_type text NOT NULL DEFAULT 'port_call',
  port_id uuid NULL REFERENCES public.ports(id) ON DELETE SET NULL,
  entered_port_text text NULL,
  entered_country_text text NULL,
  arrival_time text NULL,
  departure_time text NULL,
  is_overnight boolean NOT NULL DEFAULT false,
  notes text NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT featured_cruise_itinerary_stops_type_check
    CHECK (stop_type IN (
      'port_call',
      'embarkation',
      'disembarkation',
      'at_sea',
      'scenic_cruising',
      'overnight_port',
      'other'
    )),
  CONSTRAINT featured_cruise_itinerary_stops_day_check
    CHECK (day_number IS NULL OR day_number >= 1),
  CONSTRAINT featured_cruise_itinerary_stops_order_check
    CHECK (display_order >= 1)
);

COMMENT ON TABLE public.featured_cruise_itinerary_stops IS
  'Ordered structured itinerary stops for a Featured Cruise. Canonical source for future route maps.';
COMMENT ON COLUMN public.featured_cruise_itinerary_stops.entered_port_text IS
  'Exact customer-facing / entered wording; may differ from ports.canonical_name.';
COMMENT ON COLUMN public.featured_cruise_itinerary_stops.port_id IS
  'Link to canonical ports row. Null for At Sea and unlinked scenic rows.';

CREATE INDEX IF NOT EXISTS featured_cruise_itinerary_stops_parent_order_idx
  ON public.featured_cruise_itinerary_stops (featured_cruise_id, display_order);

CREATE INDEX IF NOT EXISTS featured_cruise_itinerary_stops_port_idx
  ON public.featured_cruise_itinerary_stops (port_id);

DROP TRIGGER IF EXISTS featured_cruise_itinerary_stops_set_updated_at
  ON public.featured_cruise_itinerary_stops;
CREATE TRIGGER featured_cruise_itinerary_stops_set_updated_at
  BEFORE UPDATE ON public.featured_cruise_itinerary_stops
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at_timestamp();

ALTER TABLE public.featured_cruise_itinerary_stops ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can select featured_cruise_itinerary_stops"
  ON public.featured_cruise_itinerary_stops;
CREATE POLICY "Admins can select featured_cruise_itinerary_stops"
  ON public.featured_cruise_itinerary_stops
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can insert featured_cruise_itinerary_stops"
  ON public.featured_cruise_itinerary_stops;
CREATE POLICY "Admins can insert featured_cruise_itinerary_stops"
  ON public.featured_cruise_itinerary_stops
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can update featured_cruise_itinerary_stops"
  ON public.featured_cruise_itinerary_stops;
CREATE POLICY "Admins can update featured_cruise_itinerary_stops"
  ON public.featured_cruise_itinerary_stops
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

DROP POLICY IF EXISTS "Admins can delete featured_cruise_itinerary_stops"
  ON public.featured_cruise_itinerary_stops;
CREATE POLICY "Admins can delete featured_cruise_itinerary_stops"
  ON public.featured_cruise_itinerary_stops
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

-- =========================================================
-- 3. Route-map status / signature on featured_cruises
-- =========================================================

ALTER TABLE public.featured_cruises
  ADD COLUMN IF NOT EXISTS route_map_status text NOT NULL DEFAULT 'missing',
  ADD COLUMN IF NOT EXISTS route_map_itinerary_signature text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'featured_cruises_route_map_status_check'
  ) THEN
    ALTER TABLE public.featured_cruises
      ADD CONSTRAINT featured_cruises_route_map_status_check
      CHECK (route_map_status IN ('current', 'needs_regeneration', 'missing', 'manual'));
  END IF;
END $$;

COMMENT ON COLUMN public.featured_cruises.route_map_status IS
  'current | needs_regeneration | missing | manual — map vs structured itinerary readiness.';
COMMENT ON COLUMN public.featured_cruises.route_map_itinerary_signature IS
  'Deterministic signature of map-relevant itinerary stops (order, type, port_id).';

-- Backfill status from existing maps without inventing signatures.
UPDATE public.featured_cruises
SET route_map_status = 'manual'
WHERE route_map_status = 'missing'
  AND (
    (route_map_media_id IS NOT NULL)
    OR (route_map_image_url IS NOT NULL AND length(trim(route_map_image_url)) > 0)
  );

-- =========================================================
-- 4. Seed common verified ports (Scenario 1 / 2 foundations)
-- =========================================================

INSERT INTO public.ports (
  canonical_name,
  display_name,
  city,
  country,
  country_code,
  region,
  aliases,
  status,
  source,
  match_key,
  verified_at
)
SELECT
  v.canonical_name,
  v.display_name,
  v.city,
  v.country,
  v.country_code,
  v.region,
  v.aliases::jsonb,
  'verified',
  'seed:sprint_13d',
  v.match_key,
  timezone('utc', now())
FROM (
  VALUES
    (
      'Barcelona',
      'Barcelona, Spain',
      'Barcelona',
      'Spain',
      'ES',
      NULL,
      '[]',
      'barcelona|spain'
    ),
    (
      'Palermo',
      'Palermo, Italy',
      'Palermo',
      'Italy',
      'IT',
      'Sicily',
      '["Palermo, Sicily"]',
      'palermo|italy'
    ),
    (
      'Piraeus',
      'Piraeus (Athens), Greece',
      'Piraeus',
      'Greece',
      'GR',
      NULL,
      '["Athens","Athens (Piraeus)","Piraeus Athens"]',
      'piraeus|greece'
    ),
    (
      'Istanbul',
      'Istanbul, Turkey',
      'Istanbul',
      'Turkey',
      'TR',
      NULL,
      '["Constantinople"]',
      'istanbul|turkey'
    )
) AS v(canonical_name, display_name, city, country, country_code, region, aliases, match_key)
WHERE NOT EXISTS (
  SELECT 1 FROM public.ports p WHERE p.match_key = v.match_key
);
