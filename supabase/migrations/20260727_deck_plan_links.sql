-- Sprint 12A — Deck Plan Links (assisted discovery + human approval)
-- Extends ci_cruise_ships. No automatic publishing. No scheduled crawlers.

ALTER TABLE public.ci_cruise_ships
  ADD COLUMN IF NOT EXISTS deck_plan_status text NOT NULL DEFAULT 'missing',
  ADD COLUMN IF NOT EXISTS deck_plan_page_url text,
  ADD COLUMN IF NOT EXISTS deck_plan_pdf_url text,
  ADD COLUMN IF NOT EXISTS deck_plan_source_type text,
  ADD COLUMN IF NOT EXISTS deck_plan_source_domain text,
  ADD COLUMN IF NOT EXISTS deck_plan_version text,
  ADD COLUMN IF NOT EXISTS deck_plan_effective_date date,
  ADD COLUMN IF NOT EXISTS deck_plan_last_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS deck_plan_verified_by text,
  ADD COLUMN IF NOT EXISTS deck_plan_notes text,
  ADD COLUMN IF NOT EXISTS deck_plan_candidates jsonb,
  ADD COLUMN IF NOT EXISTS deck_plan_last_searched_at timestamptz,
  ADD COLUMN IF NOT EXISTS deck_plan_search_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deck_plan_brave_request_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.ci_cruise_ships.deck_plan_url IS
  'Canonical approved deck-plan URL shown in My Cruise. Set only after human approval.';
COMMENT ON COLUMN public.ci_cruise_ships.deck_plan_status IS
  'missing | found | needs_review | approved | outdated | unavailable';
COMMENT ON COLUMN public.ci_cruise_ships.deck_plan_page_url IS
  'Approved official deck-plan web page URL (when applicable).';
COMMENT ON COLUMN public.ci_cruise_ships.deck_plan_pdf_url IS
  'Approved official deck-plan PDF URL (when applicable).';
COMMENT ON COLUMN public.ci_cruise_ships.deck_plan_source_type IS
  'official_page | official_pdf | official_interactive_viewer | other_official_asset';
COMMENT ON COLUMN public.ci_cruise_ships.deck_plan_candidates IS
  'Last assisted-find candidate list awaiting human review (jsonb array). Cleared on approve.';
COMMENT ON COLUMN public.ci_cruise_ships.deck_plan_last_searched_at IS
  'When assisted find last ran (cost control / cache).';
COMMENT ON COLUMN public.ci_cruise_ships.deck_plan_search_count IS
  'Lifetime assisted-find runs for this ship.';
COMMENT ON COLUMN public.ci_cruise_ships.deck_plan_brave_request_count IS
  'Lifetime Brave search requests used while finding deck plans for this ship.';

-- Backfill status from existing approved-style URL if present
UPDATE public.ci_cruise_ships
SET
  deck_plan_status = 'approved',
  deck_plan_page_url = COALESCE(NULLIF(trim(deck_plan_page_url), ''), NULLIF(trim(deck_plan_url), '')),
  deck_plan_last_verified_at = COALESCE(deck_plan_last_verified_at, last_verified_at, updated_at)
WHERE NULLIF(trim(deck_plan_url), '') IS NOT NULL
  AND deck_plan_status = 'missing';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ci_cruise_ships_deck_plan_status_chk'
  ) THEN
    ALTER TABLE public.ci_cruise_ships
      ADD CONSTRAINT ci_cruise_ships_deck_plan_status_chk
      CHECK (
        deck_plan_status IN (
          'missing',
          'found',
          'needs_review',
          'approved',
          'outdated',
          'unavailable'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ci_cruise_ships_deck_plan_source_type_chk'
  ) THEN
    ALTER TABLE public.ci_cruise_ships
      ADD CONSTRAINT ci_cruise_ships_deck_plan_source_type_chk
      CHECK (
        deck_plan_source_type IS NULL
        OR deck_plan_source_type IN (
          'official_page',
          'official_pdf',
          'official_interactive_viewer',
          'other_official_asset'
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ci_cruise_ships_deck_plan_status_idx
  ON public.ci_cruise_ships (deck_plan_status)
  WHERE active = true;

CREATE INDEX IF NOT EXISTS ci_cruise_ships_deck_plan_verified_idx
  ON public.ci_cruise_ships (deck_plan_last_verified_at DESC NULLS LAST)
  WHERE active = true;

-- Simple change history (never silent overwrite of approved sources)
CREATE TABLE IF NOT EXISTS public.deck_plan_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ship_id uuid NOT NULL REFERENCES public.ci_cruise_ships(id) ON DELETE CASCADE,
  action text NOT NULL,
  previous_url text,
  new_url text,
  administrator text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT deck_plan_history_action_chk CHECK (
    action IN (
      'source_added',
      'source_replaced',
      'source_marked_outdated',
      'source_reverified',
      'source_rejected'
    )
  )
);

CREATE INDEX IF NOT EXISTS deck_plan_history_ship_idx
  ON public.deck_plan_history (ship_id, created_at DESC);

ALTER TABLE public.deck_plan_history ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.deck_plan_history IS
  'Sprint 12A deck-plan source change history. Admin/service-role writes only.';
