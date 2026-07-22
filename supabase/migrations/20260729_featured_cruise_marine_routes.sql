-- Sprint 13E Phase 2: Persist marine Route Object per Featured Cruise.
-- Idempotent. Does NOT touch route_map_media_id (Media Library image only).
-- Requires Sprint 13D tables (ports, featured_cruise_itinerary_stops).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.featured_cruise_marine_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  featured_cruise_id uuid NOT NULL REFERENCES public.featured_cruises(id) ON DELETE CASCADE,
  itinerary_signature text NOT NULL,
  route_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_distance_nm numeric NULL,
  total_distance_km numeric NULL,
  status text NOT NULL DEFAULT 'current',
  router_engine text NULL,
  router_dataset text NULL,
  router_version text NULL,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_message text NULL,
  generated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT featured_cruise_marine_routes_status_check
    CHECK (status IN ('current', 'stale', 'error')),
  CONSTRAINT featured_cruise_marine_routes_signature_not_blank
    CHECK (length(trim(itinerary_signature)) > 0),
  CONSTRAINT featured_cruise_marine_routes_route_data_object
    CHECK (jsonb_typeof(route_data) = 'object')
);

COMMENT ON TABLE public.featured_cruise_marine_routes IS
  'One current marine Route Object per Featured Cruise (polylines + distances). Separate from route_map_media_id image.';

COMMENT ON COLUMN public.featured_cruise_marine_routes.route_data IS
  'Full Route Object JSON (version, stops, legs with full + simplified coordinates, totals, warnings).';

COMMENT ON COLUMN public.featured_cruise_marine_routes.itinerary_signature IS
  'Hash of routable geographic inputs (order, port_id, lat, lon). Detects stale geometry.';

CREATE UNIQUE INDEX IF NOT EXISTS featured_cruise_marine_routes_cruise_uidx
  ON public.featured_cruise_marine_routes (featured_cruise_id);

CREATE INDEX IF NOT EXISTS featured_cruise_marine_routes_signature_idx
  ON public.featured_cruise_marine_routes (itinerary_signature);

DROP TRIGGER IF EXISTS featured_cruise_marine_routes_set_updated_at
  ON public.featured_cruise_marine_routes;
CREATE TRIGGER featured_cruise_marine_routes_set_updated_at
  BEFORE UPDATE ON public.featured_cruise_marine_routes
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at_timestamp();

ALTER TABLE public.featured_cruise_marine_routes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can select featured_cruise_marine_routes"
  ON public.featured_cruise_marine_routes;
CREATE POLICY "Admins can select featured_cruise_marine_routes"
  ON public.featured_cruise_marine_routes
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can insert featured_cruise_marine_routes"
  ON public.featured_cruise_marine_routes;
CREATE POLICY "Admins can insert featured_cruise_marine_routes"
  ON public.featured_cruise_marine_routes
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can update featured_cruise_marine_routes"
  ON public.featured_cruise_marine_routes;
CREATE POLICY "Admins can update featured_cruise_marine_routes"
  ON public.featured_cruise_marine_routes
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

DROP POLICY IF EXISTS "Admins can delete featured_cruise_marine_routes"
  ON public.featured_cruise_marine_routes;
CREATE POLICY "Admins can delete featured_cruise_marine_routes"
  ON public.featured_cruise_marine_routes
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );
