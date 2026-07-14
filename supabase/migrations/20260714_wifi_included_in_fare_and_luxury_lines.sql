-- Phase 2 companion: fare-level Wi-Fi flag, missing cruise lines, pending rate stubs.
-- Does not alter the already-applied calculator-rates table definition beyond no-op inserts.
-- Does not invent drink prices or beverage package rows for these lines.

ALTER TABLE public.cruise_lines
  ADD COLUMN IF NOT EXISTS wifi_included_in_fare boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.cruise_lines.wifi_included_in_fare IS
  'True when Wi-Fi is included in the cruise fare (separate from drinks-package Wi-Fi inclusion).';

-- Add missing cruise lines only (match normalised names first; no duplicates).
WITH desired AS (
  SELECT *
  FROM (
    VALUES
      ('Regent Seven Seas Cruises'::text, ARRAY['regent seven seas cruises', 'regent', 'regent seven seas']::text[]),
      ('Silversea', ARRAY['silversea', 'silversea cruises']),
      ('Seabourn', ARRAY['seabourn', 'seabourn cruise line']),
      ('Viking', ARRAY['viking', 'viking cruises', 'viking ocean cruises']),
      ('Oceania', ARRAY['oceania', 'oceania cruises']),
      ('Explora Journeys', ARRAY['explora journeys', 'explora']),
      ('Crystal Cruises', ARRAY['crystal cruises', 'crystal'])
  ) AS v(canonical_name, name_aliases)
),
missing AS (
  SELECT desired.canonical_name
  FROM desired
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.cruise_lines cl
    WHERE lower(trim(cl.name)) = ANY (desired.name_aliases)
       OR lower(trim(cl.name)) = lower(trim(desired.canonical_name))
  )
)
INSERT INTO public.cruise_lines (name, logo_url, display_order, active)
SELECT canonical_name, NULL, 999, true
FROM missing;

-- Mark fare Wi-Fi for the confirmed luxury / included-Wi-Fi lines (matched by alias).
UPDATE public.cruise_lines cl
SET wifi_included_in_fare = true
WHERE EXISTS (
  SELECT 1
  FROM (
    VALUES
      (ARRAY['regent seven seas cruises', 'regent', 'regent seven seas']::text[]),
      (ARRAY['silversea', 'silversea cruises']),
      (ARRAY['seabourn', 'seabourn cruise line']),
      (ARRAY['viking', 'viking cruises', 'viking ocean cruises']),
      (ARRAY['oceania', 'oceania cruises']),
      (ARRAY['explora journeys', 'explora']),
      (ARRAY['crystal cruises', 'crystal'])
  ) AS v(name_aliases)
  WHERE lower(trim(cl.name)) = ANY (v.name_aliases)
);

-- Ensure inactive pending calculator-rate stubs exist for lines that still lack rates.
-- Drink prices remain NULL. active = false until Steve confirms a meaningful public experience.
-- drinks_included_in_fare left false unless already confirmed elsewhere (not invented here).
WITH targets AS (
  SELECT cl.id AS cruise_line_id
  FROM public.cruise_lines cl
  WHERE lower(trim(cl.name)) = ANY (
    ARRAY[
      'regent seven seas cruises',
      'regent',
      'regent seven seas',
      'viking',
      'viking cruises',
      'viking ocean cruises',
      'crystal cruises',
      'crystal'
    ]
  )
),
missing_rates AS (
  SELECT targets.cruise_line_id
  FROM targets
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.cruise_line_calculator_rates rates
    WHERE rates.cruise_line_id = targets.cruise_line_id
  )
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
  'USD',
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL,
  false,
  false,
  NULL,
  NULL,
  NULL,
  NULL,
  'Pending calculator rates — added so Admin can edit. Not activated for the public calculator.',
  NULL,
  false
FROM missing_rates
ON CONFLICT (cruise_line_id) DO NOTHING;
