-- Sprint 13E Phase 4 — Featured Cruise generated route-map asset metadata.
-- Paths point at project files under generated-assets/<id>/; SVG XML is NOT stored in DB.
-- Does NOT touch route_map_media_id / Media Library / public pages.

ALTER TABLE public.featured_cruises
  ADD COLUMN IF NOT EXISTS route_map_svg_path text,
  ADD COLUMN IF NOT EXISTS route_map_png_path text,
  ADD COLUMN IF NOT EXISTS route_map_generated_at timestamptz,
  ADD COLUMN IF NOT EXISTS route_map_renderer_version text,
  ADD COLUMN IF NOT EXISTS route_map_width integer,
  ADD COLUMN IF NOT EXISTS route_map_height integer;

COMMENT ON COLUMN public.featured_cruises.route_map_svg_path IS
  'Project-relative path to generated route-map SVG (e.g. generated-assets/<id>/route-map.svg).';
COMMENT ON COLUMN public.featured_cruises.route_map_png_path IS
  'Project-relative path to generated route-map PNG.';
COMMENT ON COLUMN public.featured_cruises.route_map_generated_at IS
  'When the SVG/PNG pair was last generated.';
COMMENT ON COLUMN public.featured_cruises.route_map_renderer_version IS
  'Route map SVG renderer version string used for generation.';
COMMENT ON COLUMN public.featured_cruises.route_map_width IS
  'Generated PNG width in pixels.';
COMMENT ON COLUMN public.featured_cruises.route_map_height IS
  'Generated PNG height in pixels.';
