-- Itinerary Needs Attention queue + notification audit.
-- Recipients are configured on admin_users (no hardcoded personal emails in app source).
--
-- Admin identity (live Original admin_users):
--   PK / assignment FK target: id (uuid)
--   Auth link for RLS: auth_user_id (uuid) — NOT user_id
--   Active flag: active (boolean) — NOT is_active
--   Notification opt-in: notify_itinerary_exceptions (added below)
--
-- assigned_admin_user_id → admin_users(id) (uuid). Optional reviewer only.
-- Idempotent / safely rerunnable: IF NOT EXISTS + DROP POLICY IF EXISTS.

ALTER TABLE public.admin_users
  ADD COLUMN IF NOT EXISTS notify_itinerary_exceptions boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.admin_users.notify_itinerary_exceptions IS
  'When true, this admin receives itinerary exception alerts (immediate + digest).';

CREATE TABLE IF NOT EXISTS public.itinerary_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id text NOT NULL,
  booking_reference text,
  customer_names text,
  cruise_line text,
  ship_name text,
  departure_date date,
  source_filename text,
  source_document_id text,
  source_document_hash text,
  exception_kind text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  concise_reason text,
  reason_codes text[] NOT NULL DEFAULT '{}',
  reason_fingerprint text NOT NULL,
  validation_failures jsonb,
  first_flagged_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  last_flagged_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  resolved_at timestamptz,
  resolved_by text,
  resolution text,
  dismiss_reason text,
  assigned_admin_user_id uuid NULL REFERENCES public.admin_users(id) ON DELETE SET NULL,
  cruise_itinerary_booking_id text,
  admin_review_path text,
  last_notified_at timestamptz,
  last_notified_fingerprint text,
  last_email_status text,
  last_email_error text,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT itinerary_exceptions_kind_check CHECK (
    exception_kind IN (
      'review_required',
      'failed',
      'replacement_conflict',
      'awaiting_extraction_stale',
      'approved_invalidated'
    )
  ),
  CONSTRAINT itinerary_exceptions_status_check CHECK (
    status IN ('open', 'resolved', 'dismissed', 'superseded')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS itinerary_exceptions_open_booking_kind_uidx
  ON public.itinerary_exceptions (booking_id, exception_kind)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS itinerary_exceptions_open_idx
  ON public.itinerary_exceptions (status, first_flagged_at DESC)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS itinerary_exceptions_booking_ref_idx
  ON public.itinerary_exceptions (booking_reference);

CREATE TABLE IF NOT EXISTS public.itinerary_exception_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exception_id uuid NULL REFERENCES public.itinerary_exceptions(id) ON DELETE SET NULL,
  booking_id text,
  booking_reference text,
  channel text NOT NULL DEFAULT 'email',
  notification_type text NOT NULL,
  reason_fingerprint text,
  recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject text,
  body_text text,
  delivery_status text NOT NULL,
  delivery_error text,
  provider text,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT itinerary_exception_notifications_type_check CHECK (
    notification_type IN ('immediate', 'digest', 'test')
  ),
  CONSTRAINT itinerary_exception_notifications_status_check CHECK (
    delivery_status IN ('sent', 'skipped', 'failed', 'dry_run')
  )
);

CREATE INDEX IF NOT EXISTS itinerary_exception_notifications_exception_idx
  ON public.itinerary_exception_notifications (exception_id, created_at DESC);

CREATE INDEX IF NOT EXISTS itinerary_exception_notifications_fp_idx
  ON public.itinerary_exception_notifications (booking_id, reason_fingerprint, notification_type);

ALTER TABLE public.itinerary_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.itinerary_exception_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can select itinerary_exceptions" ON public.itinerary_exceptions;
CREATE POLICY "Admins can select itinerary_exceptions"
  ON public.itinerary_exceptions
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.admin_users au
      WHERE au.auth_user_id = auth.uid() AND au.active = true
    )
  );

DROP POLICY IF EXISTS "Admins can select itinerary_exception_notifications" ON public.itinerary_exception_notifications;
CREATE POLICY "Admins can select itinerary_exception_notifications"
  ON public.itinerary_exception_notifications
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.admin_users au
      WHERE au.auth_user_id = auth.uid() AND au.active = true
    )
  );
