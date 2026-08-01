-- Additive ship dimension fields for My Ship scale presentation.
-- Does not populate or alter existing ship records.

ALTER TABLE public.ci_cruise_ships
  ADD COLUMN IF NOT EXISTS beam_metres numeric,
  ADD COLUMN IF NOT EXISTS cruising_speed_knots numeric;

COMMENT ON COLUMN public.ci_cruise_ships.beam_metres IS
  'Ship beam / width in metres. Optional; null when unknown.';

COMMENT ON COLUMN public.ci_cruise_ships.cruising_speed_knots IS
  'Typical cruising speed in knots. Optional; null when unknown.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ci_cruise_ships_beam_metres_positive_chk'
  ) THEN
    ALTER TABLE public.ci_cruise_ships
      ADD CONSTRAINT ci_cruise_ships_beam_metres_positive_chk
      CHECK (beam_metres IS NULL OR beam_metres > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ci_cruise_ships_cruising_speed_knots_positive_chk'
  ) THEN
    ALTER TABLE public.ci_cruise_ships
      ADD CONSTRAINT ci_cruise_ships_cruising_speed_knots_positive_chk
      CHECK (cruising_speed_knots IS NULL OR cruising_speed_knots > 0);
  END IF;
END $$;
