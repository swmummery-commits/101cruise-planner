-- Cruise Finder approved destination hero images (public read).
-- Safe to re-run. Does not store binary data in PostgreSQL.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'destination-images',
  'destination-images',
  true,
  8388608,
  ARRAY['image/png', 'image/webp', 'image/jpeg', 'image/jpg']::text[]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Public read destination-images" ON storage.objects;
CREATE POLICY "Public read destination-images"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'destination-images');
