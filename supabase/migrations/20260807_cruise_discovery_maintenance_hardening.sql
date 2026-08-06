-- Cruise Discovery maintenance hardening: database locks + rollback manifests.
-- Idempotent. Service-role Netlify functions write via REST/RPC.

CREATE TABLE IF NOT EXISTS public.cruise_discovery_maintenance_locks (
  lock_key text PRIMARY KEY,
  owner_id text NOT NULL,
  run_id text NULL,
  run_record_id uuid NULL REFERENCES public.cruise_discovery_runs(id) ON DELETE SET NULL,
  acquired_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT cruise_discovery_maintenance_locks_expires_after_acquired
    CHECK (expires_at > acquired_at)
);

COMMENT ON TABLE public.cruise_discovery_maintenance_locks IS
  'Exclusive lease for scheduled cruise inventory maintenance jobs (HAL, Celebrity, daily expiry).';

CREATE INDEX IF NOT EXISTS cruise_discovery_maintenance_locks_expires_idx
  ON public.cruise_discovery_maintenance_locks (expires_at);

CREATE TABLE IF NOT EXISTS public.cruise_discovery_maintenance_manifests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manifest_type text NOT NULL,
  run_id text NULL,
  run_record_id uuid NULL REFERENCES public.cruise_discovery_runs(id) ON DELETE SET NULL,
  cruise_line_id uuid NULL REFERENCES public.ci_cruise_lines(id) ON DELETE SET NULL,
  cruise_line_slug text NULL,
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT cruise_discovery_maintenance_manifests_type_check CHECK (
    manifest_type IN ('rollback', 'historical_audit', 'dry_run')
  )
);

CREATE INDEX IF NOT EXISTS cruise_discovery_maintenance_manifests_run_idx
  ON public.cruise_discovery_maintenance_manifests (run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS cruise_discovery_maintenance_manifests_run_record_idx
  ON public.cruise_discovery_maintenance_manifests (run_record_id);

ALTER TABLE public.cruise_discovery_maintenance_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cruise_discovery_maintenance_manifests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read maintenance locks" ON public.cruise_discovery_maintenance_locks;
CREATE POLICY "Admins can read maintenance locks"
  ON public.cruise_discovery_maintenance_locks
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can read maintenance manifests" ON public.cruise_discovery_maintenance_manifests;
CREATE POLICY "Admins can read maintenance manifests"
  ON public.cruise_discovery_maintenance_manifests
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

CREATE OR REPLACE FUNCTION public.acquire_cruise_discovery_maintenance_lock(
  p_lock_key text,
  p_owner_id text,
  p_run_id text DEFAULT NULL,
  p_run_record_id uuid DEFAULT NULL,
  p_lease_seconds integer DEFAULT 900
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := timezone('utc', now());
  v_expires timestamptz := v_now + make_interval(secs => GREATEST(p_lease_seconds, 60));
  v_row public.cruise_discovery_maintenance_locks%ROWTYPE;
BEGIN
  SELECT * INTO v_row
  FROM public.cruise_discovery_maintenance_locks
  WHERE lock_key = p_lock_key
  FOR UPDATE;

  IF FOUND AND v_row.expires_at > v_now AND v_row.owner_id <> p_owner_id THEN
    RETURN jsonb_build_object(
      'acquired', false,
      'reason', 'maintenance_lock_held',
      'lock_key', p_lock_key,
      'owner_id', v_row.owner_id,
      'expires_at', v_row.expires_at
    );
  END IF;

  INSERT INTO public.cruise_discovery_maintenance_locks (
    lock_key, owner_id, run_id, run_record_id, acquired_at, expires_at, updated_at
  ) VALUES (
    p_lock_key, p_owner_id, p_run_id, p_run_record_id, v_now, v_expires, v_now
  )
  ON CONFLICT (lock_key) DO UPDATE SET
    owner_id = EXCLUDED.owner_id,
    run_id = EXCLUDED.run_id,
    run_record_id = EXCLUDED.run_record_id,
    acquired_at = EXCLUDED.acquired_at,
    expires_at = EXCLUDED.expires_at,
    updated_at = EXCLUDED.updated_at;

  RETURN jsonb_build_object(
    'acquired', true,
    'reason', null,
    'lock_key', p_lock_key,
    'owner_id', p_owner_id,
    'expires_at', v_expires
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.release_cruise_discovery_maintenance_lock(
  p_lock_key text,
  p_owner_id text
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.cruise_discovery_maintenance_locks
  WHERE lock_key = p_lock_key AND owner_id = p_owner_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END;
$$;
