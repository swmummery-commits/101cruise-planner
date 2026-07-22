-- Sprint 13E Phase 2: Seed / backfill coordinates for common Mediterranean ports.
-- Additive only. Requires public.ports from 20260728_structured_itinerary_ports.sql.
-- Coordinates are approximate harbour positions (WGS84) for marine routing demos.

INSERT INTO public.ports (
  canonical_name, display_name, city, country, country_code, region,
  latitude, longitude, aliases, status, source, match_key, verified_at
)
SELECT
  v.canonical_name, v.display_name, v.city, v.country, v.country_code, v.region,
  v.latitude, v.longitude, v.aliases::jsonb, 'verified', 'seed:sprint_13e_coords',
  v.match_key, timezone('utc', now())
FROM (
  VALUES
    ('Barcelona', 'Barcelona, Spain', 'Barcelona', 'Spain', 'ES', NULL, 41.3584, 2.1686, '[]', 'barcelona|spain'),
    ('Marseille', 'Marseille, France', 'Marseille', 'France', 'FR', NULL, 43.2965, 5.3698, '[]', 'marseille|france'),
    ('Genoa', 'Genoa, Italy', 'Genoa', 'Italy', 'IT', NULL, 44.4056, 8.9463, '["Genova"]', 'genoa|italy'),
    ('Civitavecchia', 'Civitavecchia (Rome), Italy', 'Civitavecchia', 'Italy', 'IT', NULL, 42.093, 11.79, '["Rome","Roma","Civitavecchia Rome"]', 'civitavecchia|italy'),
    ('Naples', 'Naples, Italy', 'Naples', 'Italy', 'IT', NULL, 40.836, 14.257, '["Napoli"]', 'naples|italy'),
    ('Piraeus', 'Piraeus (Athens), Greece', 'Piraeus', 'Greece', 'GR', NULL, 37.9445, 23.6403, '["Athens","Athens (Piraeus)"]', 'piraeus|greece'),
    ('Palermo', 'Palermo, Italy', 'Palermo', 'Italy', 'IT', 'Sicily', 38.139, 13.373, '["Palermo, Sicily"]', 'palermo|italy'),
    ('Istanbul', 'Istanbul, Turkey', 'Istanbul', 'Turkey', 'TR', NULL, 41.015, 28.979, '["Constantinople"]', 'istanbul|turkey'),
    ('Miami', 'Miami, USA', 'Miami', 'United States', 'US', 'Florida', 25.778, -80.179, '[]', 'miami|united states'),
    ('Los Angeles', 'Los Angeles, USA', 'Los Angeles', 'United States', 'US', 'California', 33.732, -118.271, '["LA","San Pedro"]', 'los angeles|united states'),
    ('Auckland', 'Auckland, New Zealand', 'Auckland', 'New Zealand', 'NZ', NULL, -36.841, 174.763, '[]', 'auckland|new zealand'),
    ('Sydney', 'Sydney, Australia', 'Sydney', 'Australia', 'AU', NULL, -33.858, 151.209, '[]', 'sydney|australia')
) AS v(canonical_name, display_name, city, country, country_code, region, latitude, longitude, aliases, match_key)
WHERE NOT EXISTS (
  SELECT 1 FROM public.ports p WHERE p.match_key = v.match_key
);

-- Backfill coordinates on existing seed rows that lack them.
UPDATE public.ports p
SET
  latitude = v.latitude,
  longitude = v.longitude,
  updated_at = timezone('utc', now())
FROM (
  VALUES
    ('barcelona|spain', 41.3584, 2.1686),
    ('marseille|france', 43.2965, 5.3698),
    ('genoa|italy', 44.4056, 8.9463),
    ('civitavecchia|italy', 42.093, 11.79),
    ('naples|italy', 40.836, 14.257),
    ('piraeus|greece', 37.9445, 23.6403),
    ('palermo|italy', 38.139, 13.373),
    ('istanbul|turkey', 41.015, 28.979),
    ('miami|united states', 25.778, -80.179),
    ('los angeles|united states', 33.732, -118.271),
    ('auckland|new zealand', -36.841, 174.763),
    ('sydney|australia', -33.858, 151.209)
) AS v(match_key, latitude, longitude)
WHERE p.match_key = v.match_key
  AND (p.latitude IS NULL OR p.longitude IS NULL);
