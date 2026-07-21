-- Sprint 11B: Cruise Line Audit (Research Health foundation)
-- Additive only. Safe to re-run.
-- Soft-archive ships via ci_cruise_ships.active = false + status = 'retired'.
-- Never hard-deletes ships.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Optional cached official fleet page once verified
ALTER TABLE public.ci_cruise_lines
  ADD COLUMN IF NOT EXISTS fleet_page_url text;

COMMENT ON COLUMN public.ci_cruise_lines.fleet_page_url IS
  'Optional official fleet/ships page URL discovered or confirmed by Cruise Line Audit.';

-- =========================================================
-- Audit runs (history + current)
-- =========================================================

CREATE TABLE IF NOT EXISTS public.cruise_line_audit_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL DEFAULT 'selected',
  -- selected | full
  cruise_line_id uuid NULL REFERENCES public.ci_cruise_lines(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'queued',
  -- queued | running | completed | failed | cancelled
  fleet_page_url text NULL,
  lines_checked integer NOT NULL DEFAULT 0,
  ships_checked integer NOT NULL DEFAULT 0,
  new_ships_count integer NOT NULL DEFAULT 0,
  retired_candidates_count integer NOT NULL DEFAULT 0,
  rename_transfer_count integer NOT NULL DEFAULT 0,
  warnings_count integer NOT NULL DEFAULT 0,
  unable_to_verify_count integer NOT NULL DEFAULT 0,
  no_changes_count integer NOT NULL DEFAULT 0,
  duration_ms integer NULL,
  diagnostics_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_detail text NULL,
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT cruise_line_audit_runs_scope_check
    CHECK (scope IN ('selected', 'full')),
  CONSTRAINT cruise_line_audit_runs_status_check
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS cruise_line_audit_runs_created_idx
  ON public.cruise_line_audit_runs (created_at DESC);

CREATE INDEX IF NOT EXISTS cruise_line_audit_runs_status_idx
  ON public.cruise_line_audit_runs (status, created_at DESC);

CREATE INDEX IF NOT EXISTS cruise_line_audit_runs_line_idx
  ON public.cruise_line_audit_runs (cruise_line_id, created_at DESC)
  WHERE cruise_line_id IS NOT NULL;

-- =========================================================
-- Findings (manual review required for structural changes)
-- =========================================================

CREATE TABLE IF NOT EXISTS public.cruise_line_audit_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.cruise_line_audit_runs(id) ON DELETE CASCADE,
  cruise_line_id uuid NOT NULL REFERENCES public.ci_cruise_lines(id) ON DELETE CASCADE,
  finding_type text NOT NULL,
  -- new_ship | possible_retired | possible_rename | possible_transfer | no_changes | unable_to_verify
  status_label text NOT NULL DEFAULT '',
  ship_name text NULL,
  match_ship_id uuid NULL REFERENCES public.ci_cruise_ships(id) ON DELETE SET NULL,
  related_ship_id uuid NULL REFERENCES public.ci_cruise_ships(id) ON DELETE SET NULL,
  reason text NULL,
  confidence text NOT NULL DEFAULT 'medium',
  -- high | medium | low
  source_url text NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision text NOT NULL DEFAULT 'pending',
  -- pending | added | archived | ignored | reviewed | queued_research
  decided_at timestamptz NULL,
  decided_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  resulting_ship_id uuid NULL REFERENCES public.ci_cruise_ships(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT cruise_line_audit_findings_type_check
    CHECK (finding_type IN (
      'new_ship',
      'possible_retired',
      'possible_rename',
      'possible_transfer',
      'no_changes',
      'unable_to_verify'
    )),
  CONSTRAINT cruise_line_audit_findings_confidence_check
    CHECK (confidence IN ('high', 'medium', 'low')),
  CONSTRAINT cruise_line_audit_findings_decision_check
    CHECK (decision IN (
      'pending',
      'added',
      'archived',
      'ignored',
      'reviewed',
      'queued_research'
    ))
);

CREATE INDEX IF NOT EXISTS cruise_line_audit_findings_run_idx
  ON public.cruise_line_audit_findings (run_id, finding_type);

CREATE INDEX IF NOT EXISTS cruise_line_audit_findings_line_idx
  ON public.cruise_line_audit_findings (cruise_line_id, decision);

CREATE INDEX IF NOT EXISTS cruise_line_audit_findings_pending_idx
  ON public.cruise_line_audit_findings (decision, finding_type)
  WHERE decision = 'pending';

-- Updated-at triggers
DROP TRIGGER IF EXISTS cruise_line_audit_runs_set_updated_at ON public.cruise_line_audit_runs;
CREATE TRIGGER cruise_line_audit_runs_set_updated_at
  BEFORE UPDATE ON public.cruise_line_audit_runs
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at_timestamp();

DROP TRIGGER IF EXISTS cruise_line_audit_findings_set_updated_at ON public.cruise_line_audit_findings;
CREATE TRIGGER cruise_line_audit_findings_set_updated_at
  BEFORE UPDATE ON public.cruise_line_audit_findings
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at_timestamp();

-- RLS: service role / admin APIs use service key; no public access
ALTER TABLE public.cruise_line_audit_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cruise_line_audit_findings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins manage cruise line audit runs"
  ON public.cruise_line_audit_runs;
CREATE POLICY "Admins manage cruise line audit runs"
  ON public.cruise_line_audit_runs
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.admin_users au
      WHERE au.auth_user_id = auth.uid() AND au.active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.admin_users au
      WHERE au.auth_user_id = auth.uid() AND au.active = true
    )
  );

DROP POLICY IF EXISTS "Admins manage cruise line audit findings"
  ON public.cruise_line_audit_findings;
CREATE POLICY "Admins manage cruise line audit findings"
  ON public.cruise_line_audit_findings
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.admin_users au
      WHERE au.auth_user_id = auth.uid() AND au.active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.admin_users au
      WHERE au.auth_user_id = auth.uid() AND au.active = true
    )
  );

COMMENT ON TABLE public.cruise_line_audit_runs IS
  'Sprint 11B Cruise Line Audit history. First component of Research Health.';
COMMENT ON TABLE public.cruise_line_audit_findings IS
  'Fleet audit findings requiring manual approval before DB changes.';
