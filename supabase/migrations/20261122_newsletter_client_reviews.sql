-- Optional client-review copy and ordered photos on a newsletter issue.
-- Idempotent. Does not change existing issue numbers, dates, templates,
-- cruise assignments, or previously saved opening copy.

ALTER TABLE public.newsletters
  ADD COLUMN IF NOT EXISTS client_review_eyebrow text,
  ADD COLUMN IF NOT EXISTS client_review_headline text,
  ADD COLUMN IF NOT EXISTS client_review_text text,
  ADD COLUMN IF NOT EXISTS client_review_photos jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'newsletters_client_review_photos_array'
  ) THEN
    ALTER TABLE public.newsletters
      ADD CONSTRAINT newsletters_client_review_photos_array
      CHECK (jsonb_typeof(client_review_photos) = 'array');
  END IF;
END $$;

COMMENT ON COLUMN public.newsletters.client_review_eyebrow IS
  'Optional eyebrow above the client review. Omitted from preview and export when client_review_text is blank.';

COMMENT ON COLUMN public.newsletters.client_review_headline IS
  'Optional short heading above the client review text.';

COMMENT ON COLUMN public.newsletters.client_review_text IS
  'Client review body. The whole section is omitted from preview and Mailchimp export when this is blank or whitespace.';

COMMENT ON COLUMN public.newsletters.client_review_photos IS
  'Ordered review photos: [{id, media_id, url, alt, width, height, file_name}]. Order is the array order.';
