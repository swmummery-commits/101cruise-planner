-- Sprint 9A Phase 1: Featured Cruises foundation (Admin-only).
-- Idempotent. No anon/public access. No public views.
-- Public exposure will be added later via a sanitised view or server function.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =========================================================
-- Updated-at helper (reuse if already present)
-- =========================================================

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
-- 1. featured_cruises
-- =========================================================

CREATE TABLE IF NOT EXISTS public.featured_cruises (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  headline text NOT NULL,
  destination_strip text NULL,
  cruise_line_id uuid NULL REFERENCES public.ci_cruise_lines(id) ON DELETE SET NULL,
  cruise_ship_id uuid NULL REFERENCES public.ci_cruise_ships(id) ON DELETE SET NULL,
  departure_date date NULL,
  return_date date NULL,
  nights integer NULL,
  departure_port text NULL,
  arrival_port text NULL,
  short_editorial text NULL,
  full_description text NULL,
  hero_image_url text NULL,
  hero_image_alt text NULL,
  use_ship_hero_image boolean NOT NULL DEFAULT true,
  inclusions text NULL,
  other_information text NULL,
  newsletter_publication_date date NULL,
  publication_status text NOT NULL DEFAULT 'draft',
  create_public_page boolean NOT NULL DEFAULT false,
  public_slug text NULL,
  public_page_published_at timestamptz NULL,
  display_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT featured_cruises_status_check
    CHECK (publication_status IN ('draft', 'published', 'archived')),
  CONSTRAINT featured_cruises_nights_check
    CHECK (nights IS NULL OR nights >= 0),
  CONSTRAINT featured_cruises_slug_format_check
    CHECK (public_slug IS NULL OR public_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT featured_cruises_headline_not_blank
    CHECK (length(trim(headline)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS featured_cruises_public_slug_uidx
  ON public.featured_cruises (public_slug)
  WHERE public_slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS featured_cruises_status_idx
  ON public.featured_cruises (publication_status);

CREATE INDEX IF NOT EXISTS featured_cruises_newsletter_date_idx
  ON public.featured_cruises (newsletter_publication_date DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS featured_cruises_line_idx
  ON public.featured_cruises (cruise_line_id);

CREATE INDEX IF NOT EXISTS featured_cruises_ship_idx
  ON public.featured_cruises (cruise_ship_id);

CREATE INDEX IF NOT EXISTS featured_cruises_active_idx
  ON public.featured_cruises (active);

CREATE INDEX IF NOT EXISTS featured_cruises_display_order_idx
  ON public.featured_cruises (display_order);

DROP TRIGGER IF EXISTS featured_cruises_set_updated_at ON public.featured_cruises;
CREATE TRIGGER featured_cruises_set_updated_at
  BEFORE UPDATE ON public.featured_cruises
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at_timestamp();

ALTER TABLE public.featured_cruises ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can select featured_cruises" ON public.featured_cruises;
CREATE POLICY "Admins can select featured_cruises"
  ON public.featured_cruises
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can insert featured_cruises" ON public.featured_cruises;
CREATE POLICY "Admins can insert featured_cruises"
  ON public.featured_cruises
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can update featured_cruises" ON public.featured_cruises;
CREATE POLICY "Admins can update featured_cruises"
  ON public.featured_cruises
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

DROP POLICY IF EXISTS "Admins can delete featured_cruises" ON public.featured_cruises;
CREATE POLICY "Admins can delete featured_cruises"
  ON public.featured_cruises
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

-- No anon/public select policy.
-- Public access will be implemented later through a sanitised public view or server function
-- that must NEVER expose brochure_price, cruise_101_price, airline_price, or savings.

-- =========================================================
-- 2. featured_cruise_ports
-- =========================================================

CREATE TABLE IF NOT EXISTS public.featured_cruise_ports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  featured_cruise_id uuid NOT NULL REFERENCES public.featured_cruises(id) ON DELETE CASCADE,
  port_name text NOT NULL,
  country_or_region text NULL,
  arrival_time time NULL,
  departure_time time NULL,
  port_date date NULL,
  is_sea_day boolean NOT NULL DEFAULT false,
  latitude numeric NULL,
  longitude numeric NULL,
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT featured_cruise_ports_name_not_blank
    CHECK (length(trim(port_name)) > 0)
);

CREATE INDEX IF NOT EXISTS featured_cruise_ports_parent_order_idx
  ON public.featured_cruise_ports (featured_cruise_id, display_order);

DROP TRIGGER IF EXISTS featured_cruise_ports_set_updated_at ON public.featured_cruise_ports;
CREATE TRIGGER featured_cruise_ports_set_updated_at
  BEFORE UPDATE ON public.featured_cruise_ports
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at_timestamp();

ALTER TABLE public.featured_cruise_ports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can select featured_cruise_ports" ON public.featured_cruise_ports;
CREATE POLICY "Admins can select featured_cruise_ports"
  ON public.featured_cruise_ports
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can insert featured_cruise_ports" ON public.featured_cruise_ports;
CREATE POLICY "Admins can insert featured_cruise_ports"
  ON public.featured_cruise_ports
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can update featured_cruise_ports" ON public.featured_cruise_ports;
CREATE POLICY "Admins can update featured_cruise_ports"
  ON public.featured_cruise_ports
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

DROP POLICY IF EXISTS "Admins can delete featured_cruise_ports" ON public.featured_cruise_ports;
CREATE POLICY "Admins can delete featured_cruise_ports"
  ON public.featured_cruise_ports
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

-- =========================================================
-- 3. featured_cruise_pricing
-- =========================================================

CREATE TABLE IF NOT EXISTS public.featured_cruise_pricing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  featured_cruise_id uuid NOT NULL REFERENCES public.featured_cruises(id) ON DELETE CASCADE,
  room_label text NOT NULL,
  brochure_price numeric NULL,
  cruise_101_price numeric NULL,
  airline_price numeric NULL,
  currency_code text NOT NULL DEFAULT 'USD',
  display_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT featured_cruise_pricing_room_not_blank
    CHECK (length(trim(room_label)) > 0),
  CONSTRAINT featured_cruise_pricing_brochure_check
    CHECK (brochure_price IS NULL OR brochure_price >= 0),
  CONSTRAINT featured_cruise_pricing_101_check
    CHECK (cruise_101_price IS NULL OR cruise_101_price >= 0),
  CONSTRAINT featured_cruise_pricing_airline_check
    CHECK (airline_price IS NULL OR airline_price >= 0),
  CONSTRAINT featured_cruise_pricing_currency_check
    CHECK (currency_code ~ '^[A-Z]{3}$')
);

CREATE INDEX IF NOT EXISTS featured_cruise_pricing_parent_order_idx
  ON public.featured_cruise_pricing (featured_cruise_id, display_order);

DROP TRIGGER IF EXISTS featured_cruise_pricing_set_updated_at ON public.featured_cruise_pricing;
CREATE TRIGGER featured_cruise_pricing_set_updated_at
  BEFORE UPDATE ON public.featured_cruise_pricing
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at_timestamp();

ALTER TABLE public.featured_cruise_pricing ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can select featured_cruise_pricing" ON public.featured_cruise_pricing;
CREATE POLICY "Admins can select featured_cruise_pricing"
  ON public.featured_cruise_pricing
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can insert featured_cruise_pricing" ON public.featured_cruise_pricing;
CREATE POLICY "Admins can insert featured_cruise_pricing"
  ON public.featured_cruise_pricing
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can update featured_cruise_pricing" ON public.featured_cruise_pricing;
CREATE POLICY "Admins can update featured_cruise_pricing"
  ON public.featured_cruise_pricing
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

DROP POLICY IF EXISTS "Admins can delete featured_cruise_pricing" ON public.featured_cruise_pricing;
CREATE POLICY "Admins can delete featured_cruise_pricing"
  ON public.featured_cruise_pricing
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

-- CRITICAL: never add anon policies or public views that expose
-- brochure_price, cruise_101_price, airline_price, or derived savings.
