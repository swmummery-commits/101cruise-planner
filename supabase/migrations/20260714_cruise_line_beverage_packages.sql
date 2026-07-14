-- Phase 2: Admin-managed beverage packages for the guided Drinks Calculator.
-- Any number of packages per cruise line. Public visitor inputs are never stored.
-- Do not alter cruise_line_calculator_rates in this migration.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.set_cruise_line_beverage_packages_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = timezone('utc', now());
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.cruise_line_beverage_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cruise_line_id bigint NOT NULL REFERENCES public.cruise_lines(id) ON DELETE RESTRICT,
  package_name text NOT NULL,
  typical_daily_price numeric NULL,
  currency text NOT NULL DEFAULT 'USD',
  wifi_included boolean NOT NULL DEFAULT false,
  gratuities_included boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL DEFAULT 0,
  notes text NULL,
  last_verified_at date NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),

  CONSTRAINT cruise_line_beverage_packages_typical_daily_price_nonneg
    CHECK (typical_daily_price IS NULL OR typical_daily_price >= 0),
  CONSTRAINT cruise_line_beverage_packages_package_name_not_blank
    CHECK (length(trim(package_name)) > 0)
);

-- Case-insensitive uniqueness of package name within a cruise line.
CREATE UNIQUE INDEX IF NOT EXISTS cruise_line_beverage_packages_line_name_uidx
  ON public.cruise_line_beverage_packages (cruise_line_id, lower(trim(package_name)));

CREATE INDEX IF NOT EXISTS cruise_line_beverage_packages_line_active_idx
  ON public.cruise_line_beverage_packages (cruise_line_id, active, display_order);

DROP TRIGGER IF EXISTS cruise_line_beverage_packages_set_updated_at
  ON public.cruise_line_beverage_packages;
CREATE TRIGGER cruise_line_beverage_packages_set_updated_at
  BEFORE UPDATE ON public.cruise_line_beverage_packages
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_cruise_line_beverage_packages_updated_at();

ALTER TABLE public.cruise_line_beverage_packages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can select beverage packages"
  ON public.cruise_line_beverage_packages;
DROP POLICY IF EXISTS "Admins can insert beverage packages"
  ON public.cruise_line_beverage_packages;
DROP POLICY IF EXISTS "Admins can update beverage packages"
  ON public.cruise_line_beverage_packages;
DROP POLICY IF EXISTS "Admins can delete beverage packages"
  ON public.cruise_line_beverage_packages;

CREATE POLICY "Admins can select beverage packages"
  ON public.cruise_line_beverage_packages
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.is_admin = true
    )
  );

CREATE POLICY "Admins can insert beverage packages"
  ON public.cruise_line_beverage_packages
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.is_admin = true
    )
  );

CREATE POLICY "Admins can update beverage packages"
  ON public.cruise_line_beverage_packages
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.is_admin = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.is_admin = true
    )
  );

CREATE POLICY "Admins can delete beverage packages"
  ON public.cruise_line_beverage_packages
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.is_admin = true
    )
  );

-- Seed only packages with explicitly confirmed typical daily prices in existing
-- project source material (Azamara specialty_dining_notes from calculator rates seed).
-- Wi-Fi / gratuity inclusions for these packages are NOT confirmed — default false.
-- Princess Plus/Premier and Celebrity Classic/Premium are intentionally unseeded
-- (ranges only, or present only in design mock-ups).

WITH packages AS (
  SELECT *
  FROM (
    VALUES
      (
        ARRAY['azamara'],
        'Premium Beverage Package'::text,
        31.95::numeric,
        'USD'::text,
        false,
        false,
        true,
        10,
        'Seeded from existing calculator specialty notes. Confirm Wi-Fi and gratuity inclusions before relying on them in comparisons.'::text,
        DATE '2026-07-03'
      ),
      (
        ARRAY['azamara'],
        'Ultimate Beverage Package',
        39.95,
        'USD',
        false,
        false,
        true,
        20,
        'Seeded from existing calculator specialty notes. Confirm Wi-Fi and gratuity inclusions before relying on them in comparisons.',
        DATE '2026-07-03'
      )
  ) AS v(
    name_aliases,
    package_name,
    typical_daily_price,
    currency,
    wifi_included,
    gratuities_included,
    active,
    display_order,
    notes,
    last_verified_at
  )
),
matched AS (
  SELECT
    cl.id AS cruise_line_id,
    packages.package_name,
    packages.typical_daily_price,
    packages.currency,
    packages.wifi_included,
    packages.gratuities_included,
    packages.active,
    packages.display_order,
    packages.notes,
    packages.last_verified_at
  FROM packages
  JOIN public.cruise_lines cl
    ON lower(trim(cl.name)) = ANY (packages.name_aliases)
)
INSERT INTO public.cruise_line_beverage_packages (
  cruise_line_id,
  package_name,
  typical_daily_price,
  currency,
  wifi_included,
  gratuities_included,
  active,
  display_order,
  notes,
  last_verified_at
)
SELECT
  matched.cruise_line_id,
  matched.package_name,
  matched.typical_daily_price,
  matched.currency,
  matched.wifi_included,
  matched.gratuities_included,
  matched.active,
  matched.display_order,
  matched.notes,
  matched.last_verified_at
FROM matched
WHERE NOT EXISTS (
  SELECT 1
  FROM public.cruise_line_beverage_packages existing
  WHERE existing.cruise_line_id = matched.cruise_line_id
    AND lower(trim(existing.package_name)) = lower(trim(matched.package_name))
);
