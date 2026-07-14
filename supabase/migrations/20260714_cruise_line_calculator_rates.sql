-- Phase 1: Admin-managed drinks & Wi-Fi calculator reference rates.
-- One row per cruise line. Public visitor calculator inputs are never stored.
--
-- Note: cruise_lines.id is int8 (bigint). The FK uses bigint to match.
-- The rates table primary key remains UUID.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.set_cruise_line_calculator_rates_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = timezone('utc', now());
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.cruise_line_calculator_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cruise_line_id bigint NOT NULL REFERENCES public.cruise_lines(id) ON DELETE RESTRICT,
  currency text NOT NULL DEFAULT 'USD',

  beer_price numeric,
  wine_price numeric,
  cocktail_price numeric,
  spirits_mixer_price numeric,
  premium_coffee_price numeric,
  soft_drink_price numeric,
  juice_price numeric,
  bottled_water_price numeric,

  gratuity_percent numeric,

  drinks_included_in_fare boolean NOT NULL DEFAULT false,

  wifi_included boolean NOT NULL DEFAULT false,
  wifi_package_price numeric,
  wifi_price_label text,
  wifi_notes text,

  specialty_dining_notes text,
  general_notes text,

  last_verified_at date,
  active boolean NOT NULL DEFAULT true,

  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),

  CONSTRAINT cruise_line_calculator_rates_cruise_line_id_key UNIQUE (cruise_line_id),

  CONSTRAINT cruise_line_calculator_rates_beer_price_nonneg CHECK (beer_price IS NULL OR beer_price >= 0),
  CONSTRAINT cruise_line_calculator_rates_wine_price_nonneg CHECK (wine_price IS NULL OR wine_price >= 0),
  CONSTRAINT cruise_line_calculator_rates_cocktail_price_nonneg CHECK (cocktail_price IS NULL OR cocktail_price >= 0),
  CONSTRAINT cruise_line_calculator_rates_spirits_mixer_price_nonneg CHECK (spirits_mixer_price IS NULL OR spirits_mixer_price >= 0),
  CONSTRAINT cruise_line_calculator_rates_premium_coffee_price_nonneg CHECK (premium_coffee_price IS NULL OR premium_coffee_price >= 0),
  CONSTRAINT cruise_line_calculator_rates_soft_drink_price_nonneg CHECK (soft_drink_price IS NULL OR soft_drink_price >= 0),
  CONSTRAINT cruise_line_calculator_rates_juice_price_nonneg CHECK (juice_price IS NULL OR juice_price >= 0),
  CONSTRAINT cruise_line_calculator_rates_bottled_water_price_nonneg CHECK (bottled_water_price IS NULL OR bottled_water_price >= 0),
  CONSTRAINT cruise_line_calculator_rates_gratuity_percent_nonneg CHECK (gratuity_percent IS NULL OR gratuity_percent >= 0),
  CONSTRAINT cruise_line_calculator_rates_wifi_package_price_nonneg CHECK (wifi_package_price IS NULL OR wifi_package_price >= 0)
);

DROP TRIGGER IF EXISTS cruise_line_calculator_rates_set_updated_at ON public.cruise_line_calculator_rates;
CREATE TRIGGER cruise_line_calculator_rates_set_updated_at
  BEFORE UPDATE ON public.cruise_line_calculator_rates
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_cruise_line_calculator_rates_updated_at();

CREATE INDEX IF NOT EXISTS cruise_line_calculator_rates_active_idx
  ON public.cruise_line_calculator_rates (active);

ALTER TABLE public.cruise_line_calculator_rates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can select calculator rates" ON public.cruise_line_calculator_rates;
DROP POLICY IF EXISTS "Admins can insert calculator rates" ON public.cruise_line_calculator_rates;
DROP POLICY IF EXISTS "Admins can update calculator rates" ON public.cruise_line_calculator_rates;
DROP POLICY IF EXISTS "Admins can delete calculator rates" ON public.cruise_line_calculator_rates;

CREATE POLICY "Admins can select calculator rates"
  ON public.cruise_line_calculator_rates
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

CREATE POLICY "Admins can insert calculator rates"
  ON public.cruise_line_calculator_rates
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

CREATE POLICY "Admins can update calculator rates"
  ON public.cruise_line_calculator_rates
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

CREATE POLICY "Admins can delete calculator rates"
  ON public.cruise_line_calculator_rates
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

-- Initial seed from Cruise_calculator_drinks spreadsheet PDF.
-- Dates interpreted as Australian D/M/Y:
--   03/01/2026 = 3 January 2026
--   03/07/2026 = 3 July 2026
-- Matching uses case-insensitive cruise_lines.name variants. Unmatched rows are skipped.

WITH source AS (
  SELECT *
  FROM (
    VALUES
      (
        ARRAY['carnival', 'carnival cruise line', 'carnival cruise lines'],
        'USD', 8::numeric, 12::numeric, 11::numeric, 11::numeric, 4::numeric, 3::numeric, 3::numeric, 2::numeric,
        20::numeric, false, true, 19.55::numeric, NULL::text, NULL::text, NULL::text, NULL::text,
        DATE '2026-01-03', true
      ),
      (
        ARRAY['celebrity', 'celebrity cruises', 'celebrity cruise line'],
        'USD', 11, 12, 11, 12, 6, 3, 4, 4,
        20, false, true, 25, NULL, NULL, NULL, NULL,
        DATE '2026-01-03', true
      ),
      (
        ARRAY['cunard', 'cunard line'],
        'USD', 7.48, 11.5, 12.65, 9.2, 4.6, 4.48, 4.48, 4.48,
        18, false, true, 15, NULL, NULL, NULL, NULL,
        DATE '2026-01-03', true
      ),
      (
        ARRAY['msc', 'msc cruises', 'msc cruise line'],
        'USD', 8, 9, 10, 9, 3, 3.5, 3.5, 2.5,
        18, false, true, 20, NULL, NULL, NULL, NULL,
        DATE '2026-01-03', true
      ),
      (
        ARRAY['norwegian', 'norwegian cruise line', 'ncl'],
        'USD', 7.5, 10, 12, 12, 4, 3, 4, 6,
        20, false, true, 29.99, NULL, '$14.99 per extra device per day', NULL, NULL,
        DATE '2026-01-03', true
      ),
      (
        ARRAY['oceania', 'oceania cruises'],
        'USD', 8, 12, 12, 12, 0, 0, 0, 0,
        20, false, true, NULL, 'Free',
        '2 complimentary logins per stateroom. Streaming upgrade USD$19.99 per day',
        NULL, NULL,
        DATE '2026-01-03', true
      ),
      (
        ARRAY['princess', 'princess cruises'],
        'USD', 7.5, 11, 12, 12, 4, 3, 3, 3,
        18, false, true, 14.99, NULL,
        'If you purchase the à la carte Premier Beverage Package there is no Wi-Fi included. However, Wi-Fi is included in the Princess Plus or Princess Premier bundled fares.',
        'Princess Plus ($65 to $70 USD/day): Includes the Plus Beverage Package (drinks up to $15 USD), Wi-Fi for one device, and your daily crew appreciation (tips). Princess Premier ($100 to $105 USD/day): Includes the Premier Beverage Package (drinks up to $20 USD), Wi-Fi for four devices, tips, and unlimited specialty dining.',
        NULL,
        DATE '2026-01-03', true
      ),
      (
        ARRAY['royal caribbean', 'royal caribbean international', 'rcl', 'rccl'],
        'USD', 7.99, 11, 12, 11, 6, 3.5, 4.95, 3.25,
        18, false, false, 26.99, NULL, NULL, NULL, NULL,
        DATE '2026-07-03', true
      ),
      (
        ARRAY['silversea', 'silversea cruises'],
        'USD', 0, 0, 0, 0, 0, 0, 0, 0,
        0, true, true, 20, NULL,
        'Wi-Fi is included in all suites. If you want to upgrade your connection to the unblocked, high-speed Premium Wi-Fi tier, you can purchase the upgrade directly on board.',
        NULL,
        'Alcohol and all drinks & coffee are included in your Silversea fare.',
        DATE '2026-07-03', true
      ),
      (
        ARRAY['scenic'],
        'USD', 0, 0, 0, 0, 0, 0, 0, 0,
        0, true, true, NULL, 'Free',
        'Scenic features fleet-wide Starlink high speed internet. Scenic’s included Wi-Fi is robust enough to easily handle social media updates, messaging apps, and video streaming in real time.',
        NULL,
        'Alcohol and all drinks and coffee are included in your Scenic fare.',
        DATE '2026-07-03', true
      ),
      (
        ARRAY['seabourn'],
        'USD', 0, 0, 0, 0, 0, 0, 0, 0,
        0, true, true, NULL, 'Free',
        'Ocean View & Veranda Suites: You receive unlimited Surf Wi-Fi for one device per guest. Penthouse & Premium Suites automatically receive unlimited Stream Wi-Fi for up to four devices simultaneously, which supports video streaming and video calls.',
        NULL,
        'Alcohol and all drinks and coffee are included in your Seabourn fare.',
        DATE '2026-07-03', true
      ),
      (
        ARRAY['azamara'],
        'USD', 0, 0, 0, 0, 0, 0, 0, 0,
        0, true, true, NULL, 'Free', NULL,
        'Premium Beverage Package: Costs $31.95 USD per person, per day. It unlocks mid-tier brands like Absolut, Ketel One, Bombay Sapphire, Jack Daniel''s, and beers like Guinness or Stella Artois. Ultimate Beverage Package: Costs $39.95 USD per person, per day. It unlocks top-shelf, luxury spirits (Grey Goose, Hendrick''s, Johnnie Walker Black), an expanded menu of premium boutique wines by the glass, and high-end bottled waters (Evian, Perrier, San Pellegrino).',
        'Alcohol and all drinks and coffee are included in your Azamara fare.',
        DATE '2026-07-03', true
      ),
      (
        ARRAY['explora', 'explora journeys'],
        'USD', 0, 0, 0, 0, 0, 0, 0, 0,
        0, true, true, NULL, 'Free',
        'Explora Journeys features high-speed internet powered fleet-wide by Starlink, which is included in every room.',
        NULL,
        NULL,
        DATE '2026-07-03', true
      )
  ) AS v(
    name_aliases,
    currency,
    beer_price,
    wine_price,
    cocktail_price,
    spirits_mixer_price,
    premium_coffee_price,
    soft_drink_price,
    juice_price,
    bottled_water_price,
    gratuity_percent,
    drinks_included_in_fare,
    wifi_included,
    wifi_package_price,
    wifi_price_label,
    wifi_notes,
    specialty_dining_notes,
    general_notes,
    last_verified_at,
    active
  )
),
matched AS (
  SELECT DISTINCT ON (source.name_aliases)
    cl.id AS cruise_line_id,
    source.*
  FROM source
  JOIN public.cruise_lines cl
    ON lower(trim(cl.name)) = ANY (source.name_aliases)
  ORDER BY source.name_aliases, cl.id
)
INSERT INTO public.cruise_line_calculator_rates (
  cruise_line_id,
  currency,
  beer_price,
  wine_price,
  cocktail_price,
  spirits_mixer_price,
  premium_coffee_price,
  soft_drink_price,
  juice_price,
  bottled_water_price,
  gratuity_percent,
  drinks_included_in_fare,
  wifi_included,
  wifi_package_price,
  wifi_price_label,
  wifi_notes,
  specialty_dining_notes,
  general_notes,
  last_verified_at,
  active
)
SELECT
  cruise_line_id,
  currency,
  beer_price,
  wine_price,
  cocktail_price,
  spirits_mixer_price,
  premium_coffee_price,
  soft_drink_price,
  juice_price,
  bottled_water_price,
  gratuity_percent,
  drinks_included_in_fare,
  wifi_included,
  wifi_package_price,
  wifi_price_label,
  wifi_notes,
  specialty_dining_notes,
  general_notes,
  last_verified_at,
  active
FROM matched
ON CONFLICT (cruise_line_id) DO NOTHING;
