-- Sprint 7E: CI media storage buckets + cabin_type_summary → stateroom_breakdown conversion.
-- Safe to re-run. Does not overwrite existing logo_url / hero_image_url / stateroom_breakdown values.

-- =========================================================
-- 1. Storage buckets
-- =========================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'cruise-line-logos',
  'cruise-line-logos',
  true,
  2097152,
  ARRAY['image/png', 'image/svg+xml', 'image/webp', 'image/jpeg', 'image/jpg']::text[]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'ship-images',
  'ship-images',
  true,
  8388608,
  ARRAY['image/png', 'image/webp', 'image/jpeg', 'image/jpg']::text[]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Public read for both buckets (uploads go through service-role Netlify function).
DROP POLICY IF EXISTS "Public read cruise-line-logos" ON storage.objects;
CREATE POLICY "Public read cruise-line-logos"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'cruise-line-logos');

DROP POLICY IF EXISTS "Public read ship-images" ON storage.objects;
CREATE POLICY "Public read ship-images"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'ship-images');

-- =========================================================
-- 2. Convert cabin_type_summary → stateroom_breakdown
--    Only when breakdown is missing/empty and summary has numeric counts.
-- =========================================================

UPDATE public.ci_cruise_ships ship
SET stateroom_breakdown = converted.breakdown,
    updated_at = timezone('utc', now())
FROM (
  SELECT
    s.id,
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'label',
          CASE lower(e.key)
            WHEN 'inside' THEN 'Inside'
            WHEN 'oceanview' THEN 'Oceanview'
            WHEN 'ocean_view' THEN 'Oceanview'
            WHEN 'balcony' THEN 'Balcony'
            WHEN 'suites' THEN 'Suites'
            WHEN 'suite' THEN 'Suites'
            WHEN 'owners_suites' THEN 'Owners Suites'
            WHEN 'owner_suites' THEN 'Owners Suites'
            ELSE trim(both FROM regexp_replace(e.key, '[_]+', ' ', 'g'))
          END,
          'count', (e.value #>> '{}')::numeric::int
        )
        ORDER BY
          CASE lower(e.key)
            WHEN 'inside' THEN 1
            WHEN 'oceanview' THEN 2
            WHEN 'ocean_view' THEN 2
            WHEN 'balcony' THEN 3
            WHEN 'suites' THEN 4
            WHEN 'suite' THEN 4
            WHEN 'owners_suites' THEN 5
            WHEN 'owner_suites' THEN 5
            ELSE 100
          END,
          e.key
      )
      FROM jsonb_each(s.cabin_type_summary) AS e(key, value)
      WHERE jsonb_typeof(e.value) = 'number'
        AND (e.value #>> '{}')::numeric > 0
    ) AS breakdown
  FROM public.ci_cruise_ships s
  WHERE s.cabin_type_summary IS NOT NULL
    AND jsonb_typeof(s.cabin_type_summary) = 'object'
    AND (
      s.stateroom_breakdown IS NULL
      OR s.stateroom_breakdown = 'null'::jsonb
      OR s.stateroom_breakdown = '[]'::jsonb
      OR (
        jsonb_typeof(s.stateroom_breakdown) = 'string'
      )
    )
) AS converted
WHERE ship.id = converted.id
  AND converted.breakdown IS NOT NULL
  AND jsonb_array_length(converted.breakdown) > 0;

COMMENT ON COLUMN public.ci_cruise_ships.stateroom_breakdown IS
  'Dynamic cabin-type breakdown for admin editor and public donut chart. Array of {label, count}.';

COMMENT ON COLUMN public.ci_cruise_ships.cabin_type_summary IS
  'Original Base44 stateroom_types JSON (preserved). Prefer stateroom_breakdown for editing/display.';
