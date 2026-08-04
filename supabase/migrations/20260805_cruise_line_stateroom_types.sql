-- Cruise line ↔ stateroom type allocations for newsletter pricing dropdowns.
-- Order follows the global stateroom_types.display_order master list.

CREATE TABLE IF NOT EXISTS public.cruise_line_stateroom_types (
  cruise_line_id uuid NOT NULL REFERENCES public.ci_cruise_lines(id) ON DELETE CASCADE,
  stateroom_type_id uuid NOT NULL REFERENCES public.stateroom_types(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  PRIMARY KEY (cruise_line_id, stateroom_type_id)
);

CREATE INDEX IF NOT EXISTS cruise_line_stateroom_types_type_idx
  ON public.cruise_line_stateroom_types (stateroom_type_id);

COMMENT ON TABLE public.cruise_line_stateroom_types IS
  'Stateroom types available when entering newsletter pricing for each cruise line. Empty = fallback to all active types.';

ALTER TABLE public.cruise_line_stateroom_types ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can select cruise_line_stateroom_types"
  ON public.cruise_line_stateroom_types;
CREATE POLICY "Admins can select cruise_line_stateroom_types"
  ON public.cruise_line_stateroom_types
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can insert cruise_line_stateroom_types"
  ON public.cruise_line_stateroom_types;
CREATE POLICY "Admins can insert cruise_line_stateroom_types"
  ON public.cruise_line_stateroom_types
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can delete cruise_line_stateroom_types"
  ON public.cruise_line_stateroom_types;
CREATE POLICY "Admins can delete cruise_line_stateroom_types"
  ON public.cruise_line_stateroom_types
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );
