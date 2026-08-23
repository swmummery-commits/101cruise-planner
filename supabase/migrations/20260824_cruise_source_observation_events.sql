-- Silversea M7A: append-only cruise source observation event history.
-- Does NOT modify applied M4 state migration (20260823_cruise_source_observation_state.sql).
-- Atomically couples state advancement/resolution with immutable forensic events.

CREATE TABLE IF NOT EXISTS public.cruise_source_observation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_id uuid NOT NULL
    REFERENCES public.cruise_source_observation_state(id) ON DELETE RESTRICT,
  cruise_line_id uuid NOT NULL,
  official_sailing_id text NOT NULL,
  production_cruise_uuid uuid NULL,
  observation_type text NOT NULL,
  event_type text NOT NULL,
  record_origin text NOT NULL DEFAULT 'LIVE',
  observed_at timestamptz NOT NULL,
  observation_period_key text NULL,
  source_snapshot_hash text NULL,
  source_health text NULL,
  source_present boolean NULL,
  run_id text NULL,
  previous_count integer NOT NULL,
  new_count integer NOT NULL,
  reason_code text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT cruise_source_observation_events_official_not_blank
    CHECK (length(trim(official_sailing_id)) > 0),
  CONSTRAINT cruise_source_observation_events_type_check
    CHECK (observation_type IN ('SOURCE_ABSENT')),
  CONSTRAINT cruise_source_observation_events_event_type_check
    CHECK (event_type IN ('ABSENCE_ADVANCED', 'SOURCE_RETURN_RESOLVED')),
  CONSTRAINT cruise_source_observation_events_record_origin_check
    CHECK (record_origin IN ('LIVE', 'HISTORICAL_BACKFILL')),
  CONSTRAINT cruise_source_observation_events_counts_non_negative
    CHECK (previous_count >= 0 AND new_count >= 0),
  CONSTRAINT cruise_source_observation_events_absence_advanced_check
    CHECK (
      event_type <> 'ABSENCE_ADVANCED'
      OR (
        source_present IS FALSE
        AND source_health IN ('healthy', 'PASS')
        AND observation_period_key IS NOT NULL
        AND length(trim(observation_period_key)) > 0
        AND source_snapshot_hash IS NOT NULL
        AND length(trim(source_snapshot_hash)) > 0
        AND new_count = previous_count + 1
        AND new_count >= 1
      )
    ),
  CONSTRAINT cruise_source_observation_events_resolve_check
    CHECK (
      event_type <> 'SOURCE_RETURN_RESOLVED'
      OR (
        new_count = 0
        AND previous_count >= 1
        AND (source_present IS NULL OR source_present IS TRUE)
      )
    )
);

CREATE INDEX IF NOT EXISTS cruise_source_observation_events_state_observed_idx
  ON public.cruise_source_observation_events (state_id, observed_at ASC);

CREATE INDEX IF NOT EXISTS cruise_source_observation_events_line_official_idx
  ON public.cruise_source_observation_events (cruise_line_id, official_sailing_id);

CREATE UNIQUE INDEX IF NOT EXISTS cruise_source_observation_events_unique_week_advance_idx
  ON public.cruise_source_observation_events (state_id, observation_type, observation_period_key)
  WHERE event_type = 'ABSENCE_ADVANCED'
    AND observation_period_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS cruise_source_observation_events_unique_snapshot_advance_idx
  ON public.cruise_source_observation_events (state_id, observation_type, source_snapshot_hash)
  WHERE event_type = 'ABSENCE_ADVANCED'
    AND source_snapshot_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS cruise_source_observation_events_unique_run_advance_idx
  ON public.cruise_source_observation_events (state_id, event_type, observation_period_key, run_id)
  WHERE event_type = 'ABSENCE_ADVANCED'
    AND run_id IS NOT NULL
    AND observation_period_key IS NOT NULL;

COMMENT ON TABLE public.cruise_source_observation_events IS
  'Append-only forensic evidence for source-absence observation advances and resolutions.';

COMMENT ON COLUMN public.cruise_source_observation_events.record_origin IS
  'LIVE for RPC-generated events; HISTORICAL_BACKFILL for defensible provenance-only inserts in controlled canary phases.';

CREATE OR REPLACE FUNCTION public.cruise_source_observation_events_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'cruise_source_observation_events is append-only: % not permitted', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS cruise_source_observation_events_immutable_trigger
  ON public.cruise_source_observation_events;
CREATE TRIGGER cruise_source_observation_events_immutable_trigger
  BEFORE UPDATE OR DELETE ON public.cruise_source_observation_events
  FOR EACH ROW EXECUTE FUNCTION public.cruise_source_observation_events_immutable();

ALTER TABLE public.cruise_source_observation_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read cruise source observation events"
  ON public.cruise_source_observation_events;
CREATE POLICY "Admins can read cruise source observation events"
  ON public.cruise_source_observation_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

REVOKE INSERT, UPDATE, DELETE ON public.cruise_source_observation_events FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.cruise_source_observation_events FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.cruise_source_observation_events FROM authenticated;

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
  v_prior_count integer;
  v_action text;
  v_event_id uuid;
  v_obs_type text := coalesce(nullif(trim(p_observation_type), ''), 'SOURCE_ABSENT');
BEGIN
  IF p_cruise_line_id IS NULL OR length(trim(coalesce(p_official_sailing_id, ''))) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_parameters');
  END IF;

  IF coalesce(p_source_health, '') NOT IN ('healthy', 'PASS') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unhealthy_source', 'advanced', false);
  END IF;

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
    v_obs_type,
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
  ON CONFLICT ON CONSTRAINT cruise_source_observation_state_unique_identity DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN
    INSERT INTO public.cruise_source_observation_events (
      state_id,
      cruise_line_id,
      official_sailing_id,
      production_cruise_uuid,
      observation_type,
      event_type,
      record_origin,
      observed_at,
      observation_period_key,
      source_snapshot_hash,
      source_health,
      source_present,
      run_id,
      previous_count,
      new_count,
      reason_code,
      metadata
    ) VALUES (
      v_row.id,
      v_row.cruise_line_id,
      v_row.official_sailing_id,
      v_row.production_cruise_uuid,
      v_row.observation_type,
      'ABSENCE_ADVANCED',
      'LIVE',
      v_now,
      p_observation_period_key,
      p_source_snapshot_hash,
      p_source_health,
      false,
      p_run_id,
      0,
      1,
      coalesce(p_reason_code, 'healthy_source_miss'),
      coalesce(p_metadata, '{}'::jsonb)
    )
    RETURNING id INTO v_event_id;

    RETURN jsonb_build_object(
      'ok', true,
      'action', 'inserted',
      'advanced', true,
      'id', v_row.id,
      'event_id', v_event_id,
      'consecutive_healthy_absence_count', v_row.consecutive_healthy_absence_count,
      'status', v_row.status,
      'quarantine_eligible', false
    );
  END IF;

  SELECT * INTO v_row
  FROM public.cruise_source_observation_state
  WHERE cruise_line_id = p_cruise_line_id
    AND upper(official_sailing_id) = upper(trim(p_official_sailing_id))
    AND observation_type = v_obs_type
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'state_race_unresolved');
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

  v_prior_count := coalesce(v_row.consecutive_healthy_absence_count, 0);

  IF v_row.status = 'RESOLVED' OR v_prior_count = 0 THEN
    v_new_count := 1;
  ELSE
    v_new_count := v_prior_count + 1;
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

  INSERT INTO public.cruise_source_observation_events (
    state_id,
    cruise_line_id,
    official_sailing_id,
    production_cruise_uuid,
    observation_type,
    event_type,
    record_origin,
    observed_at,
    observation_period_key,
    source_snapshot_hash,
    source_health,
    source_present,
    run_id,
    previous_count,
    new_count,
    reason_code,
    metadata
  ) VALUES (
    v_row.id,
    v_row.cruise_line_id,
    v_row.official_sailing_id,
    v_row.production_cruise_uuid,
    v_row.observation_type,
    'ABSENCE_ADVANCED',
    'LIVE',
    v_now,
    p_observation_period_key,
    p_source_snapshot_hash,
    p_source_health,
    false,
    p_run_id,
    v_prior_count,
    v_new_count,
    coalesce(p_reason_code, 'healthy_source_miss'),
    coalesce(p_metadata, '{}'::jsonb)
  )
  RETURNING id INTO v_event_id;

  v_action := 'updated';

  RETURN jsonb_build_object(
    'ok', true,
    'action', v_action,
    'advanced', true,
    'id', v_row.id,
    'event_id', v_event_id,
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
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_source_present boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := timezone('utc', now());
  v_row public.cruise_source_observation_state%ROWTYPE;
  v_prior_count integer;
  v_event_id uuid;
  v_obs_type text := coalesce(nullif(trim(p_observation_type), ''), 'SOURCE_ABSENT');
BEGIN
  SELECT * INTO v_row
  FROM public.cruise_source_observation_state
  WHERE cruise_line_id = p_cruise_line_id
    AND upper(official_sailing_id) = upper(trim(p_official_sailing_id))
    AND observation_type = v_obs_type
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_row.status = 'RESOLVED' AND coalesce(v_row.consecutive_healthy_absence_count, 0) = 0 THEN
    RETURN jsonb_build_object(
      'ok', true,
      'action', 'idempotent_noop',
      'reason', 'already_resolved',
      'advanced', false,
      'id', v_row.id,
      'consecutive_healthy_absence_count', 0,
      'status', v_row.status,
      'resolved_at', v_row.resolved_at
    );
  END IF;

  v_prior_count := coalesce(v_row.consecutive_healthy_absence_count, 0);

  UPDATE public.cruise_source_observation_state
  SET status = 'RESOLVED',
      consecutive_healthy_absence_count = 0,
      resolved_at = v_now,
      last_run_id = coalesce(p_run_id, last_run_id),
      metadata = coalesce(p_metadata, metadata)
  WHERE id = v_row.id
  RETURNING * INTO v_row;

  INSERT INTO public.cruise_source_observation_events (
    state_id,
    cruise_line_id,
    official_sailing_id,
    production_cruise_uuid,
    observation_type,
    event_type,
    record_origin,
    observed_at,
    observation_period_key,
    source_snapshot_hash,
    source_health,
    source_present,
    run_id,
    previous_count,
    new_count,
    reason_code,
    metadata
  ) VALUES (
    v_row.id,
    v_row.cruise_line_id,
    v_row.official_sailing_id,
    v_row.production_cruise_uuid,
    v_row.observation_type,
    'SOURCE_RETURN_RESOLVED',
    'LIVE',
    v_now,
    v_row.last_observation_period_key,
    v_row.last_counted_snapshot_hash,
    v_row.last_source_health,
    coalesce(p_source_present, true),
    p_run_id,
    v_prior_count,
    0,
    'source_return',
    coalesce(p_metadata, '{}'::jsonb)
  )
  RETURNING id INTO v_event_id;

  RETURN jsonb_build_object(
    'ok', true,
    'action', 'resolved',
    'id', v_row.id,
    'event_id', v_event_id,
    'consecutive_healthy_absence_count', 0,
    'status', v_row.status,
    'resolved_at', v_row.resolved_at
  );
END;
$$;
