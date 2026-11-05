-- Optional idempotency key for newsletter cruise saves.
-- The admin save treats a repeated key as the same cruise, so a retry after
-- a lost response does not insert a second cruise. Existing rows are unchanged.

ALTER TABLE public.featured_cruises
  ADD COLUMN IF NOT EXISTS editor_client_key text;

CREATE UNIQUE INDEX IF NOT EXISTS featured_cruises_editor_client_key_idx
  ON public.featured_cruises (editor_client_key)
  WHERE editor_client_key IS NOT NULL AND editor_client_key <> '';

COMMENT ON COLUMN public.featured_cruises.editor_client_key IS
  'Browser draft key used to make a new-cruise save retry update the same row.';
