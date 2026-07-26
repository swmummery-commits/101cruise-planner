-- Exception-only itinerary auto-processing support.
-- Adds audit/idempotency columns; does not alter existing approved rows' status.
--
-- Admin identity (live Original admin_users):
--   PK: id (uuid)
--   Auth link for RLS: auth_user_id (uuid) — NOT user_id
--   Active flag: active (boolean) — NOT is_active
--
-- System automation actor:
--   cruise_itineraries.approved_by / extracted_by are uuid columns that store
--   auth.users ids for human admins. Automation cannot invent a fake auth user
--   or admin_users row. Automated approvals set:
--     approval_method = 'automated'
--     approved_by = NULL
--     extracted_by = NULL (unless a human actor uuid is supplied)
--   Application audit string "system:itinerary-auto-approve" is used only in
--   text fields (e.g. exception resolved_by), never forced into uuid columns.
--
-- Idempotent / safely rerunnable: IF NOT EXISTS + DROP POLICY IF EXISTS.
-- Safe after a failed prior run that rolled back (no partial objects on Original
-- as of investigation); also safe if some ALTERs already landed.

-- booking_documents: processing fingerprint + lock
ALTER TABLE public.booking_documents
  ADD COLUMN IF NOT EXISTS content_fingerprint text,
  ADD COLUMN IF NOT EXISTS itinerary_processing_status text,
  ADD COLUMN IF NOT EXISTS itinerary_last_processed_hash text,
  ADD COLUMN IF NOT EXISTS itinerary_last_processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS itinerary_process_lock_until timestamptz;

COMMENT ON COLUMN public.booking_documents.content_fingerprint IS
  'Stable SHA-256 fingerprint of confirmation identity used for one-shot itinerary extraction.';
COMMENT ON COLUMN public.booking_documents.itinerary_processing_status IS
  'awaiting_extraction | processing | approved_automatically | review_required | approved_manually | failed | superseded';

-- cruise_itineraries: auto-approval audit + pending replacement fields
ALTER TABLE public.cruise_itineraries
  ADD COLUMN IF NOT EXISTS source_document_id text,
  ADD COLUMN IF NOT EXISTS source_document_hash text,
  ADD COLUMN IF NOT EXISTS approval_method text,
  ADD COLUMN IF NOT EXISTS validation_version text,
  ADD COLUMN IF NOT EXISTS validation_result jsonb,
  ADD COLUMN IF NOT EXISTS processing_status text,
  ADD COLUMN IF NOT EXISTS supersedes_document_hash text,
  ADD COLUMN IF NOT EXISTS pending_itinerary_data jsonb,
  ADD COLUMN IF NOT EXISTS pending_source_document_id text,
  ADD COLUMN IF NOT EXISTS pending_source_document_hash text,
  ADD COLUMN IF NOT EXISTS pending_validation_result jsonb,
  ADD COLUMN IF NOT EXISTS pending_extracted_at timestamptz,
  ADD COLUMN IF NOT EXISTS extraction_model text,
  ADD COLUMN IF NOT EXISTS extraction_token_usage jsonb,
  ADD COLUMN IF NOT EXISTS extraction_estimated_cost_usd numeric,
  ADD COLUMN IF NOT EXISTS extraction_call_count integer DEFAULT 0;

COMMENT ON COLUMN public.cruise_itineraries.approval_method IS
  'automated | manual | null. Automated approvals use approved_by NULL (uuid column; no fake admin_users row).';
COMMENT ON COLUMN public.cruise_itineraries.processing_status IS
  'awaiting_extraction | processing | approved_automatically | review_required | approved_manually | failed | superseded';

CREATE INDEX IF NOT EXISTS cruise_itineraries_source_hash_idx
  ON public.cruise_itineraries (source_document_hash);

CREATE INDEX IF NOT EXISTS cruise_itineraries_processing_status_idx
  ON public.cruise_itineraries (processing_status);

CREATE INDEX IF NOT EXISTS booking_documents_itinerary_status_idx
  ON public.booking_documents (itinerary_processing_status);

-- Version history for superseded / replaced itineraries
CREATE TABLE IF NOT EXISTS public.cruise_itinerary_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id text NOT NULL,
  booking_reference text,
  snapshot jsonb NOT NULL,
  source_document_id text,
  source_document_hash text,
  status text,
  processing_status text,
  supersession_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cruise_itinerary_versions_booking_idx
  ON public.cruise_itinerary_versions (booking_id, created_at DESC);

ALTER TABLE public.cruise_itinerary_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can select cruise_itinerary_versions" ON public.cruise_itinerary_versions;
CREATE POLICY "Admins can select cruise_itinerary_versions"
  ON public.cruise_itinerary_versions
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.admin_users au
      WHERE au.auth_user_id = auth.uid() AND au.active = true
    )
  );
