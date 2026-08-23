-- Silversea / cruise discovery source-absence observation state (M4+).
-- Stores maintenance observation counts outside discovered_cruises business data.
-- Idempotent. No triggers on discovered_cruises. Service-role scripts mutate via RPC.

CREATE TABLE IF NOT EXISTS public.cruise_source_observation_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cruise_line_id uuid NOT NULL REFERENCES public.ci_cruise_lines(id) ON DELETE RESTRICT,
  official_sailing_id text NOT NULL,
  observation_type text NOT NULL DEFAULT 'SOURCE_ABSENT',
  status text NOT NULL DEFAULT 'OBSERVING',
  production_cruise_uuid uuid NULL,
  consecutive_healthy_absence_count integer NOT NULL DEFAULT 0,
  first_observed_at timestamptz NULL,
  last_observed_at timestamptz NULL,
  last_observation_period_key text NULL,
  last_counted_snapshot_hash text NULL,
  last_source_health text NULL,
  last_run_id text NULL,
  reason_code text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT cruise_source_observation_state_official_not_blank
    CHECK (length(trim(official_sailing_id)) > 0),
  CONSTRAINT cruise_source_observation_state_type_check
    CHECK (observation_type IN ('SOURCE_ABSENT')),
  CONSTRAINT cruise_source_observation_state_status_check
    CHECK (status IN ('OBSERVING', 'RESOLVED')),
  CONSTRAINT cruise_source_observation_state_count_non_negative
    CHECK (consecutive_healthy_absence_count >= 0),
  CONSTRAINT cruise_source_observation_state_unique_identity
    UNIQUE (cruise_line_id, official_sailing_id, observation_type)
);

CREATE INDEX IF NOT EXISTS cruise_source_observation_state_line_official_idx
  ON public.cruise_source_observation_state (cruise_line_id, official_sailing_id);

CREATE INDEX IF NOT EXISTS cruise_source_observation_state_status_idx
  ON public.cruise_source_observation_state (status, last_observed_at DESC);

COMMENT ON TABLE public.cruise_source_observation_state IS
  'Durable healthy source-absence observation counts for maintenance policy (N=3 before quarantine proposal).';

DROP TRIGGER IF EXISTS cruise_source_observation_state_set_updated_at
  ON public.cruise_source_observation_state;
CREATE TRIGGER cruise_source_observation_state_set_updated_at
  BEFORE UPDATE ON public.cruise_source_observation_state
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_timestamp();

ALTER TABLE public.cruise_source_observation_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read cruise source observation state"
  ON public.cruise_source_observation_state;
CREATE POLICY "Admins can read cruise source observation state"
  ON public.cruise_source_observation_state
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

CREATE OR REPLACE FUNCTION public.advance_cruise_source_absence_observation(
  p_cruise_line_id uuid,
  p_official_sailing_id text,
  p_production_cruise_uuid uuid DEFAULT NULL,
  p_observation_type text DEFAULT 'SOURCE_ABSENT',
  p_source_snapshot_hash text DEFAULT NULL,
  p_source_health text DEFAULT 'healthy',
  p_observation_period_key text DEFAULT NULL,
  p_run_id text DEFAULT NULL,
  p_reason_code text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := timezone('utc', now());
  v_row public.cruise_source_observation_state%ROWTYPE;
  v_new_count integer;
  v_action text;
BEGIN
  IF p_cruise_line_id IS NULL OR length(trim(coalesce(p_official_sailing_id, ''))) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_parameters');
  END IF;

  IF coalesce(p_source_health, '') NOT IN ('healthy', 'PASS') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unhealthy_source', 'advanced', false);
  END IF;

  SELECT * INTO v_row
  FROM public.cruise_source_observation_state
  WHERE cruise_line_id = p_cruise_line_id
    AND upper(official_sailing_id) = upper(trim(p_official_sailing_id))
    AND observation_type = coalesce(nullif(trim(p_observation_type), ''), 'SOURCE_ABSENT')
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.cruise_source_observation_state (
      cruise_line_id,
      official_sailing_id,
      observation_type,
      status,
      production_cruise_uuid,
      consecutive_healthy_absence_count,
      first_observed_at,
      last_observed_at,
      last_observation_period_key,
      last_counted_snapshot_hash,
      last_source_health,
      last_run_id,
      reason_code,
      metadata
    ) VALUES (
      p_cruise_line_id,
      upper(trim(p_official_sailing_id)),
      coalesce(nullif(trim(p_observation_type), ''), 'SOURCE_ABSENT'),
      'OBSERVING',
      p_production_cruise_uuid,
      1,
      v_now,
      v_now,
      p_observation_period_key,
      p_source_snapshot_hash,
      p_source_health,
      p_run_id,
      p_reason_code,
      coalesce(p_metadata, '{}'::jsonb)
    )
    RETURNING * INTO v_row;

    RETURN jsonb_build_object(
      'ok', true,
      'action', 'inserted',
      'advanced', true,
      'id', v_row.id,
      'consecutive_healthy_absence_count', v_row.consecutive_healthy_absence_count,
      'status', v_row.status,
      'quarantine_eligible', false
    );
  END IF;

  IF v_row.last_counted_snapshot_hash IS NOT NULL
     AND p_source_snapshot_hash IS NOT NULL
     AND v_row.last_counted_snapshot_hash = p_source_snapshot_hash THEN
    RETURN jsonb_build_object(
      'ok', true,
      'action', 'idempotent_noop',
      'advanced', false,
      'reason', 'snapshot_already_counted',
      'id', v_row.id,
      'consecutive_healthy_absence_count', v_row.consecutive_healthy_absence_count,
      'status', v_row.status,
      'quarantine_eligible', v_row.consecutive_healthy_absence_count >= 3
    );
  END IF;

  IF v_row.status = 'OBSERVING'
     AND v_row.last_observation_period_key IS NOT NULL
     AND p_observation_period_key IS NOT NULL
     AND v_row.last_observation_period_key = p_observation_period_key
     AND v_row.consecutive_healthy_absence_count > 0 THEN
    UPDATE public.cruise_source_observation_state
    SET last_run_id = coalesce(p_run_id, last_run_id),
        metadata = coalesce(p_metadata, metadata)
    WHERE id = v_row.id
    RETURNING * INTO v_row;

    RETURN jsonb_build_object(
      'ok', true,
      'action', 'period_already_counted',
      'advanced', false,
      'reason', 'observation_period_already_counted',
      'id', v_row.id,
      'consecutive_healthy_absence_count', v_row.consecutive_healthy_absence_count,
      'status', v_row.status,
      'quarantine_eligible', v_row.consecutive_healthy_absence_count >= 3
    );
  END IF;

  IF v_row.status = 'RESOLVED' OR coalesce(v_row.consecutive_healthy_absence_count, 0) = 0 THEN
    v_new_count := 1;
  ELSE
    v_new_count := v_row.consecutive_healthy_absence_count + 1;
  END IF;

  UPDATE public.cruise_source_observation_state
  SET status = 'OBSERVING',
      production_cruise_uuid = coalesce(p_production_cruise_uuid, production_cruise_uuid),
      consecutive_healthy_absence_count = v_new_count,
      first_observed_at = coalesce(first_observed_at, v_now),
      last_observed_at = v_now,
      last_observation_period_key = p_observation_period_key,
      last_counted_snapshot_hash = p_source_snapshot_hash,
      last_source_health = p_source_health,
      last_run_id = p_run_id,
      reason_code = coalesce(p_reason_code, reason_code),
      metadata = coalesce(p_metadata, metadata),
      resolved_at = NULL
  WHERE id = v_row.id
  RETURNING * INTO v_row;

  v_action := 'updated';

  RETURN jsonb_build_object(
    'ok', true,
    'action', v_action,
    'advanced', true,
    'id', v_row.id,
    'consecutive_healthy_absence_count', v_row.consecutive_healthy_absence_count,
    'status', v_row.status,
    'quarantine_eligible', v_row.consecutive_healthy_absence_count >= 3
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_cruise_source_absence_observation(
  p_cruise_line_id uuid,
  p_official_sailing_id text,
  p_observation_type text DEFAULT 'SOURCE_ABSENT',
  p_run_id text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := timezone('utc', now());
  v_row public.cruise_source_observation_state%ROWTYPE;
BEGIN
  UPDATE public.cruise_source_observation_state
  SET status = 'RESOLVED',
      consecutive_healthy_absence_count = 0,
      resolved_at = v_now,
      last_run_id = coalesce(p_run_id, last_run_id),
      metadata = coalesce(p_metadata, metadata)
  WHERE cruise_line_id = p_cruise_line_id
    AND upper(official_sailing_id) = upper(trim(p_official_sailing_id))
    AND observation_type = coalesce(nullif(trim(p_observation_type), ''), 'SOURCE_ABSENT')
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'action', 'resolved',
    'id', v_row.id,
    'consecutive_healthy_absence_count', 0,
    'status', v_row.status,
    'resolved_at', v_row.resolved_at
  );
END;
$$;
