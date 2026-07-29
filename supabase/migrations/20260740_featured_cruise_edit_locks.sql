-- Featured Cruise edit locks — one active editor per cruise.
-- Idempotent. Admin-only via service-role Netlify function (no browser RLS writes required).

CREATE TABLE IF NOT EXISTS public.featured_cruise_edit_locks (
  featured_cruise_id uuid PRIMARY KEY
    REFERENCES public.featured_cruises(id) ON DELETE CASCADE,
  locked_by uuid NOT NULL,
  locked_by_email text NULL,
  locked_by_name text NULL,
  lock_token uuid NOT NULL DEFAULT gen_random_uuid(),
  locked_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT featured_cruise_edit_locks_expires_after_locked
    CHECK (expires_at > locked_at)
);

COMMENT ON TABLE public.featured_cruise_edit_locks IS
  'Exclusive edit lock for Featured Cruises. Heartbeat renews expires_at; stale locks can be taken.';

CREATE INDEX IF NOT EXISTS featured_cruise_edit_locks_expires_idx
  ON public.featured_cruise_edit_locks (expires_at);

CREATE INDEX IF NOT EXISTS featured_cruise_edit_locks_locked_by_idx
  ON public.featured_cruise_edit_locks (locked_by);

ALTER TABLE public.featured_cruise_edit_locks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can select featured_cruise_edit_locks"
  ON public.featured_cruise_edit_locks;
CREATE POLICY "Admins can select featured_cruise_edit_locks"
  ON public.featured_cruise_edit_locks
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

-- Writes go through the Netlify function (service role). No authenticated INSERT/UPDATE/DELETE.
