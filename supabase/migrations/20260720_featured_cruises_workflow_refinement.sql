-- Sprint 9 Featured Cruises workflow refinement (additive only).
-- Do not edit the foundation migration. Safe to re-run.

-- itinerary_summary is the approved manually entered itinerary used for newsletter output.
-- featured_cruise_ports is retained for possible future automatically sourced day-by-day itinerary data.
-- Category values in pricing are internal references and must never be exposed publicly.

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
-- featured_cruises: additive columns
-- =========================================================

ALTER TABLE public.featured_cruises
  ADD COLUMN IF NOT EXISTS itinerary_summary text;

ALTER TABLE public.featured_cruises
  ADD COLUMN IF NOT EXISTS newsletter_number integer;

COMMENT ON COLUMN public.featured_cruises.itinerary_summary IS
  'Approved manually entered itinerary for newsletter output (pipe-separated ports).';

COMMENT ON COLUMN public.featured_cruises.newsletter_number IS
  'Newsletter edition number associated with this featured cruise.';

-- =========================================================
-- Newsletter defaults singleton
-- =========================================================

CREATE TABLE IF NOT EXISTS public.featured_cruise_newsletter_defaults (
  id integer PRIMARY KEY,
  newsletter_number integer NULL,
  newsletter_publication_date date NULL,
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT featured_cruise_newsletter_defaults_singleton CHECK (id = 1)
);

INSERT INTO public.featured_cruise_newsletter_defaults (id, newsletter_number, newsletter_publication_date)
VALUES (1, NULL, NULL)
ON CONFLICT (id) DO NOTHING;

DROP TRIGGER IF EXISTS featured_cruise_newsletter_defaults_set_updated_at
  ON public.featured_cruise_newsletter_defaults;
CREATE TRIGGER featured_cruise_newsletter_defaults_set_updated_at
  BEFORE UPDATE ON public.featured_cruise_newsletter_defaults
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at_timestamp();

ALTER TABLE public.featured_cruise_newsletter_defaults ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can select featured_cruise_newsletter_defaults"
  ON public.featured_cruise_newsletter_defaults;
CREATE POLICY "Admins can select featured_cruise_newsletter_defaults"
  ON public.featured_cruise_newsletter_defaults
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can insert featured_cruise_newsletter_defaults"
  ON public.featured_cruise_newsletter_defaults;
CREATE POLICY "Admins can insert featured_cruise_newsletter_defaults"
  ON public.featured_cruise_newsletter_defaults
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can update featured_cruise_newsletter_defaults"
  ON public.featured_cruise_newsletter_defaults;
CREATE POLICY "Admins can update featured_cruise_newsletter_defaults"
  ON public.featured_cruise_newsletter_defaults
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

-- =========================================================
-- Room type reference
-- =========================================================

CREATE TABLE IF NOT EXISTS public.featured_cruise_room_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT featured_cruise_room_types_name_not_blank CHECK (length(trim(name)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS featured_cruise_room_types_name_ci_uidx
  ON public.featured_cruise_room_types (lower(trim(name)));

DROP TRIGGER IF EXISTS featured_cruise_room_types_set_updated_at
  ON public.featured_cruise_room_types;
CREATE TRIGGER featured_cruise_room_types_set_updated_at
  BEFORE UPDATE ON public.featured_cruise_room_types
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at_timestamp();

INSERT INTO public.featured_cruise_room_types (name, sort_order)
SELECT seed.name, seed.sort_order
FROM (
  VALUES
    ('Inside', 1),
    ('Oceanview', 2),
    ('Balcony', 3),
    ('Concierge Class', 4),
    ('Aqua Class', 5),
    ('Suite', 6)
) AS seed(name, sort_order)
WHERE NOT EXISTS (
  SELECT 1
  FROM public.featured_cruise_room_types existing
  WHERE lower(trim(existing.name)) = lower(trim(seed.name))
);

ALTER TABLE public.featured_cruise_room_types ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can select featured_cruise_room_types"
  ON public.featured_cruise_room_types;
CREATE POLICY "Admins can select featured_cruise_room_types"
  ON public.featured_cruise_room_types
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can insert featured_cruise_room_types"
  ON public.featured_cruise_room_types;
CREATE POLICY "Admins can insert featured_cruise_room_types"
  ON public.featured_cruise_room_types
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can update featured_cruise_room_types"
  ON public.featured_cruise_room_types;
CREATE POLICY "Admins can update featured_cruise_room_types"
  ON public.featured_cruise_room_types
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

DROP POLICY IF EXISTS "Admins can delete featured_cruise_room_types"
  ON public.featured_cruise_room_types;
CREATE POLICY "Admins can delete featured_cruise_room_types"
  ON public.featured_cruise_room_types
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

-- =========================================================
-- Pricing: additive columns (Category is internal only)
-- =========================================================

ALTER TABLE public.featured_cruise_pricing
  ADD COLUMN IF NOT EXISTS category text;

ALTER TABLE public.featured_cruise_pricing
  ADD COLUMN IF NOT EXISTS alcohol_package boolean NOT NULL DEFAULT false;

ALTER TABLE public.featured_cruise_pricing
  ADD COLUMN IF NOT EXISTS wifi boolean NOT NULL DEFAULT false;

ALTER TABLE public.featured_cruise_pricing
  ADD COLUMN IF NOT EXISTS gratuities boolean NOT NULL DEFAULT false;

ALTER TABLE public.featured_cruise_pricing
  ADD COLUMN IF NOT EXISTS all_tours boolean NOT NULL DEFAULT false;

ALTER TABLE public.featured_cruise_pricing
  ADD COLUMN IF NOT EXISTS all_dining boolean NOT NULL DEFAULT false;

ALTER TABLE public.featured_cruise_pricing
  ADD COLUMN IF NOT EXISTS laundry boolean NOT NULL DEFAULT false;

ALTER TABLE public.featured_cruise_pricing
  ADD COLUMN IF NOT EXISTS onboard_credit numeric;

ALTER TABLE public.featured_cruise_pricing
  ADD COLUMN IF NOT EXISTS other_information text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'featured_cruise_pricing_onboard_credit_check'
  ) THEN
    ALTER TABLE public.featured_cruise_pricing
      ADD CONSTRAINT featured_cruise_pricing_onboard_credit_check
      CHECK (onboard_credit IS NULL OR onboard_credit >= 0);
  END IF;
END $$;

COMMENT ON COLUMN public.featured_cruise_pricing.category IS
  'Internal operational CAT/category reference. Never expose publicly.';

COMMENT ON TABLE public.featured_cruise_ports IS
  'Retained for possible future automatically sourced day-by-day itinerary data.';

COMMENT ON TABLE public.featured_cruise_newsletter_defaults IS
  'Singleton (id=1) current newsletter number and publication date for new Featured Cruises.';
