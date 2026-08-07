-- Smoke-test catalogue corrections for Port Image Finder.
-- Idempotent data fixes only. Safe to re-run.

UPDATE public.ports
SET
  region = 'British Columbia',
  display_name = 'Victoria, British Columbia',
  city = 'Victoria',
  country = 'Canada',
  country_code = 'CA'
WHERE canonical_name = 'Victoria BC'
  AND country = 'Canada';

UPDATE public.ports
SET
  canonical_name = 'Port Chalmers',
  display_name = 'Port Chalmers (Dunedin), New Zealand',
  city = 'Dunedin',
  region = 'Otago',
  country = 'New Zealand',
  country_code = 'NZ',
  aliases = '["Dunedin", "Port Chalmers", "Port Chalmers Dunedin"]'::jsonb,
  match_key = 'port chalmers|new zealand',
  status = 'verified'
WHERE canonical_name = 'Dunedin'
  AND country = 'New Zealand';

INSERT INTO public.ports (
  canonical_name, display_name, city, region, country, country_code,
  latitude, longitude, aliases, status, source, match_key, verified_at
)
SELECT
  'Albany',
  'Albany, Western Australia',
  'Albany',
  'Western Australia',
  'Australia',
  'AU',
  -35.0244,
  117.884,
  '["Albany WA", "Albany Western Australia"]'::jsonb,
  'verified',
  'seed:port_image_smoke',
  'albany|australia',
  timezone('utc', now())
WHERE NOT EXISTS (
  SELECT 1 FROM public.ports WHERE match_key = 'albany|australia'
);

INSERT INTO public.ports (
  canonical_name, display_name, city, region, country, country_code,
  latitude, longitude, aliases, status, source, match_key, verified_at
)
SELECT
  'Newcastle',
  'Newcastle, New South Wales',
  'Newcastle',
  'New South Wales',
  'Australia',
  'AU',
  -32.9283,
  151.7817,
  '["Newcastle NSW", "Newcastle Australia"]'::jsonb,
  'verified',
  'seed:port_image_smoke',
  'newcastle|australia',
  timezone('utc', now())
WHERE NOT EXISTS (
  SELECT 1 FROM public.ports WHERE match_key = 'newcastle|australia'
);
