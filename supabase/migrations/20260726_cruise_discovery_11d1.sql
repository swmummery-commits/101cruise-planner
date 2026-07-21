-- Sprint 11D.1: Cruise Discovery normalisation — aliases, lifecycle, audit, M2M destinations
-- Safe to re-run. HOLD DEPLOY until applied + verified.
-- Prerequisite: 20260725_cruise_discovery.sql

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =========================================================
-- 1. Lifecycle statuses on discovered_cruises
-- =========================================================

ALTER TABLE public.discovered_cruises
  DROP CONSTRAINT IF EXISTS discovered_cruises_status_check;

ALTER TABLE public.discovered_cruises
  ADD CONSTRAINT discovered_cruises_status_check CHECK (
    status IN (
      'discovered',
      'ignored_low_signal',
      'parse_failed',
      'match_required',
      'validation_failed',
      'ready',
      'active',
      'expired',
      'hidden',
      'ignored',
      'review_required'
    )
  );

COMMENT ON COLUMN public.discovered_cruises.status IS
  'Candidate lifecycle. Only status=active is a validated public cruise. review_required retained for legacy rows.';

ALTER TABLE public.discovered_cruises
  ADD COLUMN IF NOT EXISTS identity_key text;

ALTER TABLE public.discovered_cruises
  ADD COLUMN IF NOT EXISTS departure_date_raw text;

ALTER TABLE public.discovered_cruises
  ADD COLUMN IF NOT EXISTS departure_date_manual boolean NOT NULL DEFAULT false;

ALTER TABLE public.discovered_cruises
  ADD COLUMN IF NOT EXISTS departure_date_resolved_by uuid NULL;

ALTER TABLE public.discovered_cruises
  ADD COLUMN IF NOT EXISTS departure_date_resolved_at timestamptz NULL;

ALTER TABLE public.discovered_cruises
  ADD COLUMN IF NOT EXISTS return_date_raw text;

ALTER TABLE public.discovered_cruises
  ADD COLUMN IF NOT EXISTS first_seen_at timestamptz NOT NULL DEFAULT timezone('utc', now());

ALTER TABLE public.discovered_cruises
  ADD COLUMN IF NOT EXISTS change_log jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.discovered_cruises
  ADD COLUMN IF NOT EXISTS official_sailing_id text;

UPDATE public.discovered_cruises
SET first_seen_at = COALESCE(first_seen_at, discovered_at, created_at, timezone('utc', now()))
WHERE first_seen_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS discovered_cruises_identity_key_uidx
  ON public.discovered_cruises (identity_key)
  WHERE identity_key IS NOT NULL AND length(trim(identity_key)) > 0;

-- =========================================================
-- 2. Many-to-many destination associations
-- =========================================================

CREATE TABLE IF NOT EXISTS public.discovered_cruise_destinations (
  cruise_id uuid NOT NULL REFERENCES public.discovered_cruises(id) ON DELETE CASCADE,
  destination_id uuid NOT NULL REFERENCES public.destinations(id) ON DELETE CASCADE,
  evidence text NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  PRIMARY KEY (cruise_id, destination_id)
);

CREATE INDEX IF NOT EXISTS discovered_cruise_destinations_dest_idx
  ON public.discovered_cruise_destinations (destination_id);

ALTER TABLE public.discovered_cruise_destinations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can read destinations for active cruises" ON public.discovered_cruise_destinations;
CREATE POLICY "Public can read destinations for active cruises"
  ON public.discovered_cruise_destinations
  FOR SELECT
  TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.discovered_cruises c
      WHERE c.id = cruise_id AND c.status = 'active'
    )
  );

DROP POLICY IF EXISTS "Admins can read cruise destinations" ON public.discovered_cruise_destinations;
CREATE POLICY "Admins can read cruise destinations"
  ON public.discovered_cruise_destinations
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

-- =========================================================
-- 3. Ship aliases (line-scoped, reusable)
-- =========================================================

CREATE TABLE IF NOT EXISTS public.cruise_ship_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ship_id uuid NOT NULL REFERENCES public.ci_cruise_ships(id) ON DELETE CASCADE,
  cruise_line_id uuid NOT NULL REFERENCES public.ci_cruise_lines(id) ON DELETE CASCADE,
  raw_alias text NOT NULL,
  normalised_alias text NOT NULL,
  source text NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT cruise_ship_aliases_raw_not_blank CHECK (length(trim(raw_alias)) > 0),
  CONSTRAINT cruise_ship_aliases_norm_not_blank CHECK (length(trim(normalised_alias)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS cruise_ship_aliases_line_norm_uidx
  ON public.cruise_ship_aliases (cruise_line_id, lower(normalised_alias))
  WHERE active = true;

CREATE INDEX IF NOT EXISTS cruise_ship_aliases_ship_idx
  ON public.cruise_ship_aliases (ship_id)
  WHERE active = true;

DROP TRIGGER IF EXISTS cruise_ship_aliases_set_updated_at ON public.cruise_ship_aliases;
CREATE TRIGGER cruise_ship_aliases_set_updated_at
  BEFORE UPDATE ON public.cruise_ship_aliases
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at_timestamp();

ALTER TABLE public.cruise_ship_aliases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read ship aliases" ON public.cruise_ship_aliases;
CREATE POLICY "Admins can read ship aliases"
  ON public.cruise_ship_aliases
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

COMMENT ON TABLE public.cruise_ship_aliases IS
  'Line-scoped ship name aliases for Cruise Discovery. Never applied across cruise lines.';

-- =========================================================
-- 4. Destination aliases for discovery evidence
-- =========================================================

CREATE TABLE IF NOT EXISTS public.cruise_destination_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_id uuid NOT NULL REFERENCES public.destinations(id) ON DELETE CASCADE,
  raw_alias text NOT NULL,
  normalised_alias text NOT NULL,
  source text NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT cruise_destination_aliases_raw_not_blank CHECK (length(trim(raw_alias)) > 0),
  CONSTRAINT cruise_destination_aliases_norm_not_blank CHECK (length(trim(normalised_alias)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS cruise_destination_aliases_norm_uidx
  ON public.cruise_destination_aliases (lower(normalised_alias))
  WHERE active = true;

DROP TRIGGER IF EXISTS cruise_destination_aliases_set_updated_at ON public.cruise_destination_aliases;
CREATE TRIGGER cruise_destination_aliases_set_updated_at
  BEFORE UPDATE ON public.cruise_destination_aliases
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at_timestamp();

ALTER TABLE public.cruise_destination_aliases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read destination aliases" ON public.cruise_destination_aliases;
CREATE POLICY "Admins can read destination aliases"
  ON public.cruise_destination_aliases
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

-- =========================================================
-- 5. Review resolution audit trail
-- =========================================================

CREATE TABLE IF NOT EXISTS public.cruise_discovery_resolution_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id uuid NULL REFERENCES public.cruise_discovery_review_items(id) ON DELETE SET NULL,
  group_id text NULL,
  action text NOT NULL,
  original_extract jsonb NOT NULL DEFAULT '{}'::jsonb,
  normalised_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  selected_match jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence numeric NULL,
  alias_created_id uuid NULL REFERENCES public.cruise_ship_aliases(id) ON DELETE SET NULL,
  manual_date jsonb NULL,
  official_url_applied text NULL,
  candidates_reprocessed integer NOT NULL DEFAULT 0,
  cruises_promoted integer NOT NULL DEFAULT 0,
  candidates_unresolved integer NOT NULL DEFAULT 0,
  actor_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT cruise_discovery_resolution_audit_action_not_blank CHECK (length(trim(action)) > 0)
);

CREATE INDEX IF NOT EXISTS cruise_discovery_resolution_audit_created_idx
  ON public.cruise_discovery_resolution_audit (created_at DESC);

CREATE INDEX IF NOT EXISTS cruise_discovery_resolution_audit_group_idx
  ON public.cruise_discovery_resolution_audit (group_id)
  WHERE group_id IS NOT NULL;

ALTER TABLE public.cruise_discovery_resolution_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read resolution audit" ON public.cruise_discovery_resolution_audit;
CREATE POLICY "Admins can read resolution audit"
  ON public.cruise_discovery_resolution_audit
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

-- =========================================================
-- 6. Review item tracking for group collapse / first-last seen
-- =========================================================

ALTER TABLE public.cruise_discovery_review_items
  ADD COLUMN IF NOT EXISTS first_seen_at timestamptz NOT NULL DEFAULT timezone('utc', now());

ALTER TABLE public.cruise_discovery_review_items
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT timezone('utc', now());

ALTER TABLE public.cruise_discovery_review_items
  ADD COLUMN IF NOT EXISTS entity_group_key text;

ALTER TABLE public.cruise_discovery_review_items
  ADD COLUMN IF NOT EXISTS affected_external_keys jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE public.cruise_discovery_review_items
SET first_seen_at = COALESCE(first_seen_at, created_at, timezone('utc', now())),
    last_seen_at = COALESCE(last_seen_at, created_at, timezone('utc', now()))
WHERE true;

CREATE INDEX IF NOT EXISTS cruise_discovery_review_items_group_key_idx
  ON public.cruise_discovery_review_items (entity_group_key)
  WHERE entity_group_key IS NOT NULL AND status = 'pending';

-- =========================================================
-- 7. Backfill legacy review_required → match_required / validation_failed (best-effort)
-- =========================================================

UPDATE public.discovered_cruises
SET status = 'match_required'
WHERE status = 'review_required'
  AND (ship_id IS NULL OR destination_id IS NULL);

UPDATE public.discovered_cruises
SET status = 'validation_failed'
WHERE status = 'review_required'
  AND ship_id IS NOT NULL
  AND destination_id IS NOT NULL;
