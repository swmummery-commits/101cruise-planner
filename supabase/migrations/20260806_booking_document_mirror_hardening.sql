-- Base44 booking document mirror hardening.
-- Idempotent: safe to re-run. Preserves existing Booking Confirmation rows.
-- Does not alter Storage bucket privacy or hard-delete documents.

ALTER TABLE public.booking_documents
  ADD COLUMN IF NOT EXISTS source_fingerprint text,
  ADD COLUMN IF NOT EXISTS source_file_url_hash text,
  ADD COLUMN IF NOT EXISTS original_filename text,
  ADD COLUMN IF NOT EXISTS storage_bucket text,
  ADD COLUMN IF NOT EXISTS mime_type text,
  ADD COLUMN IF NOT EXISTS file_size bigint,
  ADD COLUMN IF NOT EXISTS content_hash text,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS source_deleted_at timestamptz;

COMMENT ON COLUMN public.booking_documents.source_fingerprint IS
  'Stable Base44 document identity (Base44 id or deterministic metadata hash).';
COMMENT ON COLUMN public.booking_documents.source_file_url_hash IS
  'SHA-256 of source file_url — detects URL changes without filename changes.';
COMMENT ON COLUMN public.booking_documents.content_hash IS
  'SHA-256 of mirrored file bytes in Storage when available.';
COMMENT ON COLUMN public.booking_documents.is_active IS
  'False when document no longer present in authoritative Base44 documents[] fetch.';
COMMENT ON COLUMN public.booking_documents.source_deleted_at IS
  'When Base44 no longer listed this document after a complete successful sync.';

-- Backfill fingerprint and active flags for existing Base44 rows.
UPDATE public.booking_documents
SET
  source_fingerprint = COALESCE(
    NULLIF(trim(base44_document_id), ''),
    NULLIF(trim(replace(sync_key, 'base44:', '')), ''),
    NULLIF(trim(replace(sync_key, 'base44-hash:', '')), '')
  ),
  original_filename = COALESCE(original_filename, filename),
  storage_bucket = COALESCE(storage_bucket, CASE WHEN storage_path IS NOT NULL THEN 'booking-documents' ELSE NULL END),
  last_seen_at = COALESCE(last_seen_at, last_synced_at, updated_at, created_at),
  synced_at = COALESCE(synced_at, last_synced_at, updated_at, created_at),
  is_active = COALESCE(is_active, true)
WHERE source_system = 'base44'
  AND (
    source_fingerprint IS NULL
    OR last_seen_at IS NULL
    OR synced_at IS NULL
    OR original_filename IS NULL
  );

-- Soft-deactivate duplicate active Base44 rows sharing the same booking + fingerprint.
-- Keeps the most recently synced row; never hard-deletes.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY base44_booking_id, source_fingerprint
      ORDER BY COALESCE(last_synced_at, synced_at, updated_at, created_at) DESC NULLS LAST, id DESC
    ) AS rn
  FROM public.booking_documents
  WHERE source_system = 'base44'
    AND is_active = true
    AND source_fingerprint IS NOT NULL
    AND base44_booking_id IS NOT NULL
)
UPDATE public.booking_documents bd
SET
  is_active = false,
  source_deleted_at = COALESCE(bd.source_deleted_at, timezone('utc', now())),
  updated_at = timezone('utc', now())
FROM ranked r
WHERE bd.id = r.id
  AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS booking_documents_base44_source_fingerprint_uidx
  ON public.booking_documents (base44_booking_id, source_fingerprint)
  WHERE source_system = 'base44'
    AND source_fingerprint IS NOT NULL
    AND is_active = true;

CREATE INDEX IF NOT EXISTS booking_documents_active_booking_idx
  ON public.booking_documents (base44_booking_id, is_active, document_visible_to_customer);

CREATE INDEX IF NOT EXISTS booking_documents_last_seen_idx
  ON public.booking_documents (last_seen_at DESC NULLS LAST)
  WHERE source_system = 'base44';
