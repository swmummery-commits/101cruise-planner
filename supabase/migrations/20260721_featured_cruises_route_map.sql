-- Additive: optional route map image for newsletter and public cruise pages.

ALTER TABLE public.featured_cruises
  ADD COLUMN IF NOT EXISTS route_map_image_url text;

COMMENT ON COLUMN public.featured_cruises.route_map_image_url IS
  'Optional manually supplied route map image URL for newsletter and public cruise pages.';
