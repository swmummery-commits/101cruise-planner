-- Stateroom Types — central reference for cruise pricing room type labels.
-- Idempotent: safe to run more than once.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.set_updated_at_timestamp()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = timezone('utc', now());
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.stateroom_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  normalized_name text NOT NULL,
  display_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT stateroom_types_name_not_blank CHECK (length(trim(name)) > 0),
  CONSTRAINT stateroom_types_normalized_name_not_blank CHECK (length(trim(normalized_name)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS stateroom_types_normalized_name_uidx
  ON public.stateroom_types (normalized_name);

CREATE INDEX IF NOT EXISTS stateroom_types_active_order_idx
  ON public.stateroom_types (display_order ASC, name ASC)
  WHERE is_active = true;

COMMENT ON TABLE public.stateroom_types IS
  'Canonical stateroom / room type labels for newsletter and featured cruise pricing dropdowns.';

DROP TRIGGER IF EXISTS stateroom_types_set_updated_at ON public.stateroom_types;
CREATE TRIGGER stateroom_types_set_updated_at
  BEFORE UPDATE ON public.stateroom_types
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at_timestamp();

-- Seed: hard-coded defaults, existing featured_cruise_room_types, and distinct pricing labels.
WITH canonical AS (
  SELECT name, sort_order::integer AS display_order, 1 AS priority
  FROM (
    VALUES
      ('Inside', 1),
      ('Oceanview', 2),
      ('Balcony', 3),
      ('Concierge Class', 4),
      ('Aqua Class', 5),
      ('Suite', 6)
  ) AS v(name, sort_order)
),
from_room_types AS (
  SELECT
    trim(rt.name) AS name,
    rt.sort_order AS display_order,
    2 AS priority
  FROM public.featured_cruise_room_types rt
  WHERE length(trim(rt.name)) > 0
),
from_pricing AS (
  SELECT
    trim(p.room_label) AS name,
    1000 + row_number() OVER (ORDER BY lower(trim(p.room_label))) AS display_order,
    3 AS priority
  FROM (
    SELECT DISTINCT trim(room_label) AS room_label
    FROM public.featured_cruise_pricing
    WHERE length(trim(room_label)) > 0
  ) p
),
combined AS (
  SELECT name, display_order, priority FROM canonical
  UNION ALL
  SELECT name, display_order, priority FROM from_room_types
  UNION ALL
  SELECT name, display_order, priority FROM from_pricing
),
deduped AS (
  SELECT DISTINCT ON (lower(trim(name)))
    trim(name) AS name,
    display_order,
    priority
  FROM combined
  WHERE length(trim(name)) > 0
  ORDER BY lower(trim(name)), priority ASC, display_order ASC, trim(name) ASC
)
INSERT INTO public.stateroom_types (name, normalized_name, display_order, is_active)
SELECT
  d.name,
  lower(trim(d.name)) AS normalized_name,
  d.display_order,
  true
FROM deduped d
WHERE NOT EXISTS (
  SELECT 1
  FROM public.stateroom_types existing
  WHERE existing.normalized_name = lower(trim(d.name))
);

ALTER TABLE public.stateroom_types ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can select stateroom_types" ON public.stateroom_types;
CREATE POLICY "Admins can select stateroom_types"
  ON public.stateroom_types
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can insert stateroom_types" ON public.stateroom_types;
CREATE POLICY "Admins can insert stateroom_types"
  ON public.stateroom_types
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can update stateroom_types" ON public.stateroom_types;
CREATE POLICY "Admins can update stateroom_types"
  ON public.stateroom_types
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

DROP POLICY IF EXISTS "Admins can delete stateroom_types" ON public.stateroom_types;
CREATE POLICY "Admins can delete stateroom_types"
  ON public.stateroom_types
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );
