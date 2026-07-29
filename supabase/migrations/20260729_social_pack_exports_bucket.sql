-- Ephemeral Social Pack ZIP exports (Admin download only).
-- Not Media Library. Service-role upload; private read via signed URL.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'social-pack-exports',
  'social-pack-exports',
  false,
  52428800, -- 50 MB
  ARRAY['application/zip', 'application/x-zip-compressed']::text[]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- No anon policies — service role only.
