-- Transactional ship hero replacement for Media Library.
-- Prefer calling via media-library set_ship_hero (service role). This RPC
-- provides a true single-statement transaction when applied in Supabase.

CREATE OR REPLACE FUNCTION public.set_ship_hero_media(p_media_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_media public.media_library%ROWTYPE;
  v_ship public.ci_cruise_ships%ROWTYPE;
  v_prev_defaults uuid[];
  v_default_count integer;
BEGIN
  IF p_media_id IS NULL THEN
    RAISE EXCEPTION 'id is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_media
  FROM public.media_library
  WHERE id = p_media_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Media not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_media.media_type IS DISTINCT FROM 'ship' THEN
    RAISE EXCEPTION 'Only ship images can be set as the ship hero' USING ERRCODE = '22023';
  END IF;

  IF v_media.ship_id IS NULL THEN
    RAISE EXCEPTION 'This image is not associated with a ship' USING ERRCODE = '22023';
  END IF;

  IF v_media.public_url IS NULL OR btrim(v_media.public_url) = ''
     OR v_media.public_url !~* '^https?://' THEN
    RAISE EXCEPTION 'This image does not have a valid public URL' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ship
  FROM public.ci_cruise_ships
  WHERE id = v_media.ship_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Associated ship was not found in Cruise Intelligence' USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(array_agg(id), '{}'::uuid[])
  INTO v_prev_defaults
  FROM public.media_library
  WHERE ship_id = v_ship.id
    AND media_type = 'ship'
    AND is_default = true;

  UPDATE public.media_library
  SET is_default = false
  WHERE ship_id = v_ship.id
    AND media_type = 'ship'
    AND is_default = true;

  UPDATE public.media_library
  SET is_default = true
  WHERE id = v_media.id;

  UPDATE public.ci_cruise_ships
  SET hero_image_url = v_media.public_url,
      last_verified_at = now()
  WHERE id = v_ship.id;

  SELECT count(*)::integer INTO v_default_count
  FROM public.media_library
  WHERE ship_id = v_ship.id
    AND media_type = 'ship'
    AND is_default = true;

  IF v_default_count <> 1 THEN
    RAISE EXCEPTION 'Ship hero update left an invalid default state' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'media_id', v_media.id,
    'ship_id', v_ship.id,
    'hero_image_url', v_media.public_url,
    'previous_default_ids', to_jsonb(v_prev_defaults),
    'message', 'Ship hero updated.'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_ship_hero_media(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_ship_hero_media(uuid) TO service_role;

COMMENT ON FUNCTION public.set_ship_hero_media(uuid) IS
  'Atomically set one media_library ship image as sole default and update ci_cruise_ships.hero_image_url.';
