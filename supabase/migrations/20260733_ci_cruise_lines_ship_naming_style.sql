-- Sprint 13F: Per-cruise-line ship naming policy.
--
-- Canonical storage stays on ci_cruise_ships.name. This column records how each
-- line prefers vessel names to be kept when cleaning duplicates / imports:
--   undecided        — not yet reviewed
--   short_vessel     — vessel only (Allura); strip redundant line-brand prefixes
--   branded_vessel   — official names include brand (Explora I, Carnival Celebration)
--   honorific_vessel — prefer MS/MV house style (Holland America, Hurtigruten)

ALTER TABLE public.ci_cruise_lines
  ADD COLUMN IF NOT EXISTS ship_naming_style text NOT NULL DEFAULT 'undecided';

ALTER TABLE public.ci_cruise_lines
  DROP CONSTRAINT IF EXISTS ci_cruise_lines_ship_naming_style_check;

ALTER TABLE public.ci_cruise_lines
  ADD CONSTRAINT ci_cruise_lines_ship_naming_style_check
  CHECK (
    ship_naming_style IN (
      'undecided',
      'short_vessel',
      'branded_vessel',
      'honorific_vessel'
    )
  );

COMMENT ON COLUMN public.ci_cruise_lines.ship_naming_style IS
  'Per-line canonical ship naming: undecided | short_vessel | branded_vessel | honorific_vessel';

-- Seed decisions already agreed in product review.
UPDATE public.ci_cruise_lines
SET
  ship_naming_style = 'short_vessel',
  updated_at = timezone('utc', now())
WHERE lower(trim(name)) = 'oceania cruises';

UPDATE public.ci_cruise_lines
SET
  ship_naming_style = 'branded_vessel',
  updated_at = timezone('utc', now())
WHERE lower(trim(name)) = 'explora journeys';

UPDATE public.ci_cruise_lines
SET
  ship_naming_style = 'short_vessel',
  updated_at = timezone('utc', now())
WHERE lower(trim(name)) = 'ritz-carlton yacht collection';
