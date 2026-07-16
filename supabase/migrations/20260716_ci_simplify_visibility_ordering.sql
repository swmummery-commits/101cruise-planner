-- Simplify Cruise Intelligence visibility and ordering.
-- Scope: ci_cruise_lines / ci_cruise_ships only.
-- Does not alter drinks-calculator public.cruise_lines or public.ships.
--
-- Rules after this migration:
-- - Cruise lines always ordered alphabetically by name
-- - sold_by_101cruise implies public visibility (no separate public_visible)
-- - excluded_reason removed (use sold_by_101cruise = false / active = false instead)

-- Drop dependent policies first
DROP POLICY IF EXISTS "Public can read visible cruise intelligence lines"
  ON public.ci_cruise_lines;
DROP POLICY IF EXISTS "Public can read visible cruise intelligence ships"
  ON public.ci_cruise_ships;

DROP INDEX IF EXISTS public.ci_cruise_lines_public_idx;
DROP INDEX IF EXISTS public.ci_cruise_ships_line_idx;

ALTER TABLE public.ci_cruise_lines
  DROP COLUMN IF EXISTS display_order,
  DROP COLUMN IF EXISTS public_visible,
  DROP COLUMN IF EXISTS excluded_reason;

ALTER TABLE public.ci_cruise_ships
  DROP COLUMN IF EXISTS public_visible;

CREATE INDEX IF NOT EXISTS ci_cruise_lines_public_idx
  ON public.ci_cruise_lines (sold_by_101cruise, active, name);

CREATE INDEX IF NOT EXISTS ci_cruise_ships_line_idx
  ON public.ci_cruise_ships (cruise_line_id, active);

-- Public read: active + sold by 101cruise
CREATE POLICY "Public can read visible cruise intelligence lines"
  ON public.ci_cruise_lines
  FOR SELECT
  TO anon, authenticated
  USING (
    active = true
    AND sold_by_101cruise = true
  );

-- Ships: active + parent line active and sold
CREATE POLICY "Public can read visible cruise intelligence ships"
  ON public.ci_cruise_ships
  FOR SELECT
  TO anon, authenticated
  USING (
    active = true
    AND EXISTS (
      SELECT 1
      FROM public.ci_cruise_lines cl
      WHERE cl.id = ci_cruise_ships.cruise_line_id
        AND cl.active = true
        AND cl.sold_by_101cruise = true
    )
  );

COMMENT ON COLUMN public.ci_cruise_lines.sold_by_101cruise IS
  'When true (and active), the line is publicly visible. No separate public_visible column.';
