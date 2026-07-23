-- Sprint 13E: Backfill harbour coordinates for Iberian + SE Asia ports used by Featured Cruises.
-- Additive only. Approximate WGS84 cruise-terminal positions for marine routing / route maps.

UPDATE public.ports AS p
SET
  latitude = v.latitude,
  longitude = v.longitude,
  status = 'verified',
  source = COALESCE(NULLIF(p.source, ''), 'seed:sprint_13e_coords_iberia_seasia'),
  updated_at = timezone('utc', now())
FROM (
  VALUES
    ('palma de mallorca|spain', 39.5686, 2.6425),
    ('alicante|spain', 38.3431, -0.4815),
    ('cartagena|spain', 37.598, -0.986),
    ('malaga|spain', 36.709, -4.418),
    ('seville|spain', 37.3585, -6.025),
    ('portimao|portugal', 37.128, -8.537),
    ('lisbon|portugal', 38.713, -9.129),
    ('bangkok|thailand', 13.7035, 100.584),
    ('ko samui|thailand', 9.512, 99.938),
    ('ho chi minh city|vietnam', 10.768, 106.707),
    ('kota kinabalu|malaysia', 5.996, 116.077),
    ('muara|brunei', 5.027, 115.066),
    ('singapore|singapore', 1.264, 103.819)
) AS v(match_key, latitude, longitude)
WHERE p.match_key = v.match_key
  AND (p.latitude IS NULL OR p.longitude IS NULL);
