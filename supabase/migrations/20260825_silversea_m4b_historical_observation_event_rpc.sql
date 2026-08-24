-- Silversea M7B: idempotent M4B historical observation event backfill RPC only.
-- Does NOT modify cruise_source_observation_state. Does NOT call advance RPC semantics.

CREATE OR REPLACE FUNCTION public.insert_m4b_historical_source_absence_observation_event(
  p_confirm_token text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state public.cruise_source_observation_state%ROWTYPE;
  v_event_id uuid;
  v_existing uuid;
  v_state_id constant uuid := 'c5abc742-fe7e-4846-94d2-973813de2478';
  v_official constant text := 'SN280222C25';
  v_period constant text := '2026-W34';
  v_hash constant text := '9550e5128173d201211609428dae83790482c055037a7853a493090d444d39df';
BEGIN
  IF coalesce(p_confirm_token, '') <> 'SILVERSEA-M7B-M4B-HISTORICAL-EVENT' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_confirm_token');
  END IF;

  SELECT * INTO v_state
  FROM public.cruise_source_observation_state
  WHERE id = v_state_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'state_not_found');
  END IF;

  IF upper(v_state.official_sailing_id) <> v_official THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'state_identity_mismatch');
  END IF;

  IF v_state.consecutive_healthy_absence_count <> 1
     OR v_state.status <> 'OBSERVING'
     OR v_state.last_observation_period_key <> v_period
     OR v_state.last_counted_snapshot_hash <> v_hash THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'state_evidence_mismatch');
  END IF;

  SELECT id INTO v_existing
  FROM public.cruise_source_observation_events
  WHERE state_id = v_state_id
    AND event_type = 'ABSENCE_ADVANCED'
    AND observation_period_key = v_period
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true,
      'action', 'idempotent_noop',
      'reason', 'historical_event_already_present',
      'event_id', v_existing,
      'state_id', v_state_id
    );
  END IF;

  SELECT id INTO v_existing
  FROM public.cruise_source_observation_events
  WHERE state_id = v_state_id
    AND event_type = 'ABSENCE_ADVANCED'
    AND source_snapshot_hash = v_hash
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true,
      'action', 'idempotent_noop',
      'reason', 'snapshot_event_already_present',
      'event_id', v_existing,
      'state_id', v_state_id
    );
  END IF;

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
    v_state.id,
    v_state.cruise_line_id,
    v_state.official_sailing_id,
    v_state.production_cruise_uuid,
    v_state.observation_type,
    'ABSENCE_ADVANCED',
    'HISTORICAL_BACKFILL',
    '2026-08-23T08:14:47.92398+00:00'::timestamptz,
    v_period,
    v_hash,
    'healthy',
    false,
    'silversea-m4-source-absence-SN280222C25-2026-08-23T08-13-17-474Z',
    0,
    1,
    'healthy_source_miss',
    jsonb_build_object(
      'phase', 'M7B',
      'backfill_of', 'M4B',
      'provenance', 'exact_m4b_production_observation_insert'
    )
  )
  RETURNING id INTO v_event_id;

  RETURN jsonb_build_object(
    'ok', true,
    'action', 'inserted',
    'event_id', v_event_id,
    'state_id', v_state_id,
    'observation_state_writes', 0
  );
END;
$$;

REVOKE ALL ON FUNCTION public.insert_m4b_historical_source_absence_observation_event(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.insert_m4b_historical_source_absence_observation_event(text) TO service_role;
