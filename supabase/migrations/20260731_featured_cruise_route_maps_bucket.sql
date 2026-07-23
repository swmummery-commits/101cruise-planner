-- Sprint 13E Phase 4B — Supabase Storage bucket for Featured Cruise route maps.
-- Public bucket: marketing maps for Admin preview and future public pages.
-- Uploads are performed server-side via the service role (Netlify Function).
-- Safe to re-run.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'featured-cruise-route-maps',
  'featured-cruise-route-maps',
  true,
  15728640, -- 15 MB (SVG+coastal can be large; PNG ~1–2 MB)
  ARRAY['image/svg+xml', 'image/png']::text[]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Public read for Admin previews and future Featured Cruise pages.
DROP POLICY IF EXISTS "Public read featured-cruise-route-maps" ON storage.objects;
CREATE POLICY "Public read featured-cruise-route-maps"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'featured-cruise-route-maps');

-- No anon INSERT/UPDATE/DELETE — Netlify Function uses the service role.

-- Clarify metadata columns now store Supabase Storage object paths (not local disk).
COMMENT ON COLUMN public.featured_cruises.route_map_svg_path IS
  'Supabase Storage object path in bucket featured-cruise-route-maps (e.g. <featured-cruise-id>/route-map.svg).';
COMMENT ON COLUMN public.featured_cruises.route_map_png_path IS
  'Supabase Storage object path in bucket featured-cruise-route-maps (e.g. <featured-cruise-id>/route-map.png).';

-- Clear any Phase 4A local filesystem paths that cannot work on hosted Netlify.
UPDATE public.featured_cruises
SET
  route_map_svg_path = NULL,
  route_map_png_path = NULL,
  route_map_generated_at = NULL,
  route_map_renderer_version = NULL,
  route_map_width = NULL,
  route_map_height = NULL,
  updated_at = timezone('utc', now())
WHERE route_map_svg_path LIKE 'generated-assets/%'
   OR route_map_png_path LIKE 'generated-assets/%'
   OR route_map_svg_path LIKE '/generated-assets/%'
   OR route_map_png_path LIKE '/generated-assets/%';
