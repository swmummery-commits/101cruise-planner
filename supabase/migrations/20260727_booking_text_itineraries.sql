-- Lightweight text-only cruise itineraries extracted from Booking Confirmations.
-- One current row per booking (upsert by booking_id). Does not modify cruise_itineraries map data.
--
-- Admin identity (live Original admin_users):
--   PK: id (uuid)
--   Auth link for RLS: auth_user_id (uuid)
--   Active flag: active (boolean)
--
-- Idempotent / safely rerunnable: IF NOT EXISTS + DROP POLICY IF EXISTS.

CREATE TABLE IF NOT EXISTS public.booking_text_itineraries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id text NOT NULL,
  booking_reference text,
  source_document_id text,
  document_fingerprint text,
  itinerary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  extraction_status text NOT NULL DEFAULT 'pending',
  extraction_error text,
  extracted_at timestamptz,
  extraction_model text,
  extraction_token_usage jsonb,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT booking_text_itineraries_status_check CHECK (
    extraction_status IN ('pending', 'ready', 'failed', 'processing')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS booking_text_itineraries_booking_id_uidx
  ON public.booking_text_itineraries (booking_id);

CREATE INDEX IF NOT EXISTS booking_text_itineraries_booking_ref_idx
  ON public.booking_text_itineraries (booking_reference);

CREATE INDEX IF NOT EXISTS booking_text_itineraries_document_fp_idx
  ON public.booking_text_itineraries (document_fingerprint);

COMMENT ON TABLE public.booking_text_itineraries IS
  'Text-only itinerary extracted from Booking Confirmation PDFs. One current row per booking.';

DROP TRIGGER IF EXISTS booking_text_itineraries_set_updated_at ON public.booking_text_itineraries;
CREATE TRIGGER booking_text_itineraries_set_updated_at
  BEFORE UPDATE ON public.booking_text_itineraries
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at_timestamp();

ALTER TABLE public.booking_text_itineraries ENABLE ROW LEVEL SECURITY;

-- Writes: service role only (no authenticated INSERT/UPDATE/DELETE policies).
-- Customer reads go through Netlify functions using the service role.

DROP POLICY IF EXISTS "Admins can select booking_text_itineraries" ON public.booking_text_itineraries;
CREATE POLICY "Admins can select booking_text_itineraries"
  ON public.booking_text_itineraries
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.admin_users au
      WHERE au.auth_user_id = auth.uid() AND au.active = true
    )
  );
