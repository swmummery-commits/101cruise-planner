-- Featured cruise admin access — SECURITY DEFINER gate for RLS policies.
-- Fixes INSERT/UPDATE failures when profiles RLS prevents policy subqueries from
-- reading is_admin, and aligns featured_* tables with admin_users allow-list.

CREATE OR REPLACE FUNCTION public.is_active_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.is_admin IS TRUE
    )
    OR EXISTS (
      SELECT 1
      FROM public.admin_users au
      WHERE au.auth_user_id = auth.uid()
        AND au.active IS TRUE
    );
$$;

REVOKE ALL ON FUNCTION public.is_active_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_active_admin() TO authenticated;

COMMENT ON FUNCTION public.is_active_admin() IS
  'True when auth.uid() is an active admin (profiles.is_admin or admin_users.active).';

-- featured_cruises
DROP POLICY IF EXISTS "Admins can select featured_cruises" ON public.featured_cruises;
CREATE POLICY "Admins can select featured_cruises"
  ON public.featured_cruises
  FOR SELECT
  TO authenticated
  USING ((SELECT public.is_active_admin()));

DROP POLICY IF EXISTS "Admins can insert featured_cruises" ON public.featured_cruises;
CREATE POLICY "Admins can insert featured_cruises"
  ON public.featured_cruises
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.is_active_admin()));

DROP POLICY IF EXISTS "Admins can update featured_cruises" ON public.featured_cruises;
CREATE POLICY "Admins can update featured_cruises"
  ON public.featured_cruises
  FOR UPDATE
  TO authenticated
  USING ((SELECT public.is_active_admin()))
  WITH CHECK ((SELECT public.is_active_admin()));

DROP POLICY IF EXISTS "Admins can delete featured_cruises" ON public.featured_cruises;
CREATE POLICY "Admins can delete featured_cruises"
  ON public.featured_cruises
  FOR DELETE
  TO authenticated
  USING ((SELECT public.is_active_admin()));

-- featured_cruise_pricing
DROP POLICY IF EXISTS "Admins can select featured_cruise_pricing" ON public.featured_cruise_pricing;
CREATE POLICY "Admins can select featured_cruise_pricing"
  ON public.featured_cruise_pricing
  FOR SELECT
  TO authenticated
  USING ((SELECT public.is_active_admin()));

DROP POLICY IF EXISTS "Admins can insert featured_cruise_pricing" ON public.featured_cruise_pricing;
CREATE POLICY "Admins can insert featured_cruise_pricing"
  ON public.featured_cruise_pricing
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.is_active_admin()));

DROP POLICY IF EXISTS "Admins can update featured_cruise_pricing" ON public.featured_cruise_pricing;
CREATE POLICY "Admins can update featured_cruise_pricing"
  ON public.featured_cruise_pricing
  FOR UPDATE
  TO authenticated
  USING ((SELECT public.is_active_admin()))
  WITH CHECK ((SELECT public.is_active_admin()));

DROP POLICY IF EXISTS "Admins can delete featured_cruise_pricing" ON public.featured_cruise_pricing;
CREATE POLICY "Admins can delete featured_cruise_pricing"
  ON public.featured_cruise_pricing
  FOR DELETE
  TO authenticated
  USING ((SELECT public.is_active_admin()));

-- featured_cruise_ports
DROP POLICY IF EXISTS "Admins can select featured_cruise_ports" ON public.featured_cruise_ports;
CREATE POLICY "Admins can select featured_cruise_ports"
  ON public.featured_cruise_ports
  FOR SELECT
  TO authenticated
  USING ((SELECT public.is_active_admin()));

DROP POLICY IF EXISTS "Admins can insert featured_cruise_ports" ON public.featured_cruise_ports;
CREATE POLICY "Admins can insert featured_cruise_ports"
  ON public.featured_cruise_ports
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.is_active_admin()));

DROP POLICY IF EXISTS "Admins can update featured_cruise_ports" ON public.featured_cruise_ports;
CREATE POLICY "Admins can update featured_cruise_ports"
  ON public.featured_cruise_ports
  FOR UPDATE
  TO authenticated
  USING ((SELECT public.is_active_admin()))
  WITH CHECK ((SELECT public.is_active_admin()));

DROP POLICY IF EXISTS "Admins can delete featured_cruise_ports" ON public.featured_cruise_ports;
CREATE POLICY "Admins can delete featured_cruise_ports"
  ON public.featured_cruise_ports
  FOR DELETE
  TO authenticated
  USING ((SELECT public.is_active_admin()));

-- featured_cruise_itinerary_stops
DROP POLICY IF EXISTS "Admins can select featured_cruise_itinerary_stops" ON public.featured_cruise_itinerary_stops;
CREATE POLICY "Admins can select featured_cruise_itinerary_stops"
  ON public.featured_cruise_itinerary_stops
  FOR SELECT
  TO authenticated
  USING ((SELECT public.is_active_admin()));

DROP POLICY IF EXISTS "Admins can insert featured_cruise_itinerary_stops" ON public.featured_cruise_itinerary_stops;
CREATE POLICY "Admins can insert featured_cruise_itinerary_stops"
  ON public.featured_cruise_itinerary_stops
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.is_active_admin()));

DROP POLICY IF EXISTS "Admins can update featured_cruise_itinerary_stops" ON public.featured_cruise_itinerary_stops;
CREATE POLICY "Admins can update featured_cruise_itinerary_stops"
  ON public.featured_cruise_itinerary_stops
  FOR UPDATE
  TO authenticated
  USING ((SELECT public.is_active_admin()))
  WITH CHECK ((SELECT public.is_active_admin()));

DROP POLICY IF EXISTS "Admins can delete featured_cruise_itinerary_stops" ON public.featured_cruise_itinerary_stops;
CREATE POLICY "Admins can delete featured_cruise_itinerary_stops"
  ON public.featured_cruise_itinerary_stops
  FOR DELETE
  TO authenticated
  USING ((SELECT public.is_active_admin()));

-- featured_cruise_marine_routes
DROP POLICY IF EXISTS "Admins can select featured_cruise_marine_routes" ON public.featured_cruise_marine_routes;
CREATE POLICY "Admins can select featured_cruise_marine_routes"
  ON public.featured_cruise_marine_routes
  FOR SELECT
  TO authenticated
  USING ((SELECT public.is_active_admin()));

DROP POLICY IF EXISTS "Admins can insert featured_cruise_marine_routes" ON public.featured_cruise_marine_routes;
CREATE POLICY "Admins can insert featured_cruise_marine_routes"
  ON public.featured_cruise_marine_routes
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.is_active_admin()));

DROP POLICY IF EXISTS "Admins can update featured_cruise_marine_routes" ON public.featured_cruise_marine_routes;
CREATE POLICY "Admins can update featured_cruise_marine_routes"
  ON public.featured_cruise_marine_routes
  FOR UPDATE
  TO authenticated
  USING ((SELECT public.is_active_admin()))
  WITH CHECK ((SELECT public.is_active_admin()));

DROP POLICY IF EXISTS "Admins can delete featured_cruise_marine_routes" ON public.featured_cruise_marine_routes;
CREATE POLICY "Admins can delete featured_cruise_marine_routes"
  ON public.featured_cruise_marine_routes
  FOR DELETE
  TO authenticated
  USING ((SELECT public.is_active_admin()));

-- featured_cruise_newsletter_defaults
DROP POLICY IF EXISTS "Admins can select featured_cruise_newsletter_defaults" ON public.featured_cruise_newsletter_defaults;
CREATE POLICY "Admins can select featured_cruise_newsletter_defaults"
  ON public.featured_cruise_newsletter_defaults
  FOR SELECT
  TO authenticated
  USING ((SELECT public.is_active_admin()));

DROP POLICY IF EXISTS "Admins can insert featured_cruise_newsletter_defaults" ON public.featured_cruise_newsletter_defaults;
CREATE POLICY "Admins can insert featured_cruise_newsletter_defaults"
  ON public.featured_cruise_newsletter_defaults
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.is_active_admin()));

DROP POLICY IF EXISTS "Admins can update featured_cruise_newsletter_defaults" ON public.featured_cruise_newsletter_defaults;
CREATE POLICY "Admins can update featured_cruise_newsletter_defaults"
  ON public.featured_cruise_newsletter_defaults
  FOR UPDATE
  TO authenticated
  USING ((SELECT public.is_active_admin()))
  WITH CHECK ((SELECT public.is_active_admin()));

-- featured_cruise_room_types (legacy — may not exist on all envs)
DO $$
BEGIN
  IF to_regclass('public.featured_cruise_room_types') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "Admins can select featured_cruise_room_types" ON public.featured_cruise_room_types';
    EXECUTE $p$
      CREATE POLICY "Admins can select featured_cruise_room_types"
        ON public.featured_cruise_room_types
        FOR SELECT TO authenticated
        USING ((SELECT public.is_active_admin()))
    $p$;
    EXECUTE 'DROP POLICY IF EXISTS "Admins can insert featured_cruise_room_types" ON public.featured_cruise_room_types';
    EXECUTE $p$
      CREATE POLICY "Admins can insert featured_cruise_room_types"
        ON public.featured_cruise_room_types
        FOR INSERT TO authenticated
        WITH CHECK ((SELECT public.is_active_admin()))
    $p$;
    EXECUTE 'DROP POLICY IF EXISTS "Admins can update featured_cruise_room_types" ON public.featured_cruise_room_types';
    EXECUTE $p$
      CREATE POLICY "Admins can update featured_cruise_room_types"
        ON public.featured_cruise_room_types
        FOR UPDATE TO authenticated
        USING ((SELECT public.is_active_admin()))
        WITH CHECK ((SELECT public.is_active_admin()))
    $p$;
    EXECUTE 'DROP POLICY IF EXISTS "Admins can delete featured_cruise_room_types" ON public.featured_cruise_room_types';
    EXECUTE $p$
      CREATE POLICY "Admins can delete featured_cruise_room_types"
        ON public.featured_cruise_room_types
        FOR DELETE TO authenticated
        USING ((SELECT public.is_active_admin()))
    $p$;
  END IF;
END $$;

-- featured_cruise_edit_locks (select only — writes via service role)
DROP POLICY IF EXISTS "Admins can select featured_cruise_edit_locks" ON public.featured_cruise_edit_locks;
CREATE POLICY "Admins can select featured_cruise_edit_locks"
  ON public.featured_cruise_edit_locks
  FOR SELECT
  TO authenticated
  USING ((SELECT public.is_active_admin()));
