-- Line-local ship feature catalogue (Exclusive Areas + Specialty Features).
-- Class templates pick from this catalogue via checkboxes; names are branded per line.

CREATE TABLE IF NOT EXISTS public.ci_cruise_line_features (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cruise_line_id uuid NOT NULL REFERENCES public.ci_cruise_lines(id) ON DELETE CASCADE,
  feature_type text NOT NULL CHECK (feature_type IN ('exclusive_area', 'specialty_feature')),
  name text NOT NULL,
  normalized_name text NOT NULL,
  description text,
  icon_key text NOT NULL DEFAULT 'sparkles',
  display_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT ci_cruise_line_features_name_len CHECK (char_length(trim(name)) > 0),
  CONSTRAINT ci_cruise_line_features_unique_name UNIQUE (cruise_line_id, feature_type, normalized_name)
);

CREATE INDEX IF NOT EXISTS ci_cruise_line_features_line_type_order_idx
  ON public.ci_cruise_line_features (cruise_line_id, feature_type, display_order, name);

COMMENT ON TABLE public.ci_cruise_line_features IS
  'Branded Exclusive Areas and Specialty Features per cruise line. Class templates select from this catalogue.';

ALTER TABLE public.ci_cruise_line_features ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can select ci_cruise_line_features" ON public.ci_cruise_line_features;
CREATE POLICY "Admins can select ci_cruise_line_features"
  ON public.ci_cruise_line_features
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can insert ci_cruise_line_features" ON public.ci_cruise_line_features;
CREATE POLICY "Admins can insert ci_cruise_line_features"
  ON public.ci_cruise_line_features
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can update ci_cruise_line_features" ON public.ci_cruise_line_features;
CREATE POLICY "Admins can update ci_cruise_line_features"
  ON public.ci_cruise_line_features
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

DROP POLICY IF EXISTS "Admins can delete ci_cruise_line_features" ON public.ci_cruise_line_features;
CREATE POLICY "Admins can delete ci_cruise_line_features"
  ON public.ci_cruise_line_features
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

-- Seed from saved class templates (structured JSON objects only).
INSERT INTO public.ci_cruise_line_features (
  cruise_line_id,
  feature_type,
  name,
  normalized_name,
  description,
  icon_key,
  display_order
)
SELECT
  cruise_line_id,
  feature_type,
  name,
  normalized_name,
  NULLIF(description, ''),
  icon_key,
  (ROW_NUMBER() OVER (PARTITION BY cruise_line_id, feature_type ORDER BY name) * 10)::integer AS display_order
FROM (
  SELECT DISTINCT
    t.cruise_line_id,
    'exclusive_area'::text AS feature_type,
    trim(COALESCE(elem->>'name', elem->>'label', '')) AS name,
    lower(trim(COALESCE(elem->>'name', elem->>'label', ''))) AS normalized_name,
    trim(COALESCE(elem->>'description', '')) AS description,
    COALESCE(NULLIF(trim(elem->>'icon_key'), ''), 'sparkles') AS icon_key
  FROM public.ci_ship_class_facility_templates t
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.exclusive_areas, '[]'::jsonb)) AS elem
  WHERE jsonb_typeof(elem) = 'object'
    AND trim(COALESCE(elem->>'name', elem->>'label', '')) <> ''

  UNION

  SELECT DISTINCT
    t.cruise_line_id,
    'specialty_feature'::text AS feature_type,
    trim(COALESCE(elem->>'name', elem->>'label', '')) AS name,
    lower(trim(COALESCE(elem->>'name', elem->>'label', ''))) AS normalized_name,
    trim(COALESCE(elem->>'description', '')) AS description,
    COALESCE(NULLIF(trim(elem->>'icon_key'), ''), 'sparkles') AS icon_key
  FROM public.ci_ship_class_facility_templates t
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.specialty_features, '[]'::jsonb)) AS elem
  WHERE jsonb_typeof(elem) = 'object'
    AND trim(COALESCE(elem->>'name', elem->>'label', '')) <> ''
) seeded
WHERE normalized_name <> ''
ON CONFLICT (cruise_line_id, feature_type, normalized_name) DO NOTHING;
