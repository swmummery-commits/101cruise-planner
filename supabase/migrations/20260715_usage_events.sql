-- Usage & Insights: engagement event log (Phase 1 foundation).
-- Records tool usage only — never customer-entered content.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  user_id uuid NULL,
  booking_reference text NULL,
  session_id text NOT NULL,
  surface text NOT NULL,
  module text NOT NULL,
  event_type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  device_type text NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),

  CONSTRAINT usage_events_surface_check
    CHECK (surface IN ('my_cruise', 'public_tools', 'admin')),
  CONSTRAINT usage_events_module_check
    CHECK (module IN (
      'dashboard',
      'booking',
      'packing',
      'preparation',
      'documents',
      'budget',
      'the_ship',
      'drinks_calculator',
      'public_drinks_calculator'
    )),
  CONSTRAINT usage_events_event_type_check
    CHECK (event_type IN (
      'page_open',
      'tool_started',
      'tool_completed',
      'save',
      'document_upload',
      'login',
      'logout'
    )),
  CONSTRAINT usage_events_device_type_check
    CHECK (device_type IS NULL OR device_type IN ('desktop', 'tablet', 'mobile', 'unknown')),
  CONSTRAINT usage_events_session_id_not_blank
    CHECK (length(trim(session_id)) > 0),
  CONSTRAINT usage_events_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS usage_events_occurred_at_idx
  ON public.usage_events (occurred_at DESC);

CREATE INDEX IF NOT EXISTS usage_events_module_occurred_idx
  ON public.usage_events (module, occurred_at DESC);

CREATE INDEX IF NOT EXISTS usage_events_booking_occurred_idx
  ON public.usage_events (booking_reference, occurred_at DESC)
  WHERE booking_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS usage_events_session_module_type_idx
  ON public.usage_events (session_id, module, event_type);

CREATE INDEX IF NOT EXISTS usage_events_surface_occurred_idx
  ON public.usage_events (surface, occurred_at DESC);

COMMENT ON TABLE public.usage_events IS
  'Engagement analytics only. Do not store packing lists, budgets, notes, document contents, or other customer-entered tool data.';

COMMENT ON COLUMN public.usage_events.metadata IS
  'Safe non-personal keys only (e.g. cruise_line, customer_label, line_slug). Never store tool input values.';

ALTER TABLE public.usage_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can select usage events" ON public.usage_events;
DROP POLICY IF EXISTS "Admins can insert usage events" ON public.usage_events;
DROP POLICY IF EXISTS "Admins can update usage events" ON public.usage_events;
DROP POLICY IF EXISTS "Admins can delete usage events" ON public.usage_events;

-- Admin read-only via authenticated JWT. Writes go through Netlify (service role).
CREATE POLICY "Admins can select usage events"
  ON public.usage_events
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.is_admin = true
    )
  );
