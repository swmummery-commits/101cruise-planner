-- Class-level Exclusive Areas + Specialty Features templates per cruise line + ship class.
-- Admin-only via Netlify service role. No browser/client access to this table.

CREATE TABLE IF NOT EXISTS public.ci_ship_class_facility_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cruise_line_id uuid NOT NULL REFERENCES public.ci_cruise_lines(id) ON DELETE CASCADE,
  class_name text NOT NULL,
  class_key text NOT NULL,
  exclusive_areas jsonb NOT NULL DEFAULT '[]'::jsonb,
  specialty_features jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ci_ship_class_facility_templates_class_name_not_blank CHECK (length(trim(class_name)) > 0),
  CONSTRAINT ci_ship_class_facility_templates_class_key_not_blank CHECK (length(trim(class_key)) > 0),
  UNIQUE (cruise_line_id, class_key)
);

CREATE INDEX IF NOT EXISTS ci_ship_class_facility_templates_line_idx
  ON public.ci_ship_class_facility_templates (cruise_line_id);

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ci_ship_class_facility_templates_set_updated_at ON public.ci_ship_class_facility_templates;
CREATE TRIGGER ci_ship_class_facility_templates_set_updated_at
  BEFORE UPDATE ON public.ci_ship_class_facility_templates
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.ci_ship_class_facility_templates IS
  'Admin templates for Exclusive Areas and Specialty Features shared by ships in a cruise-line class. Server access only.';

ALTER TABLE public.ci_ship_class_facility_templates ENABLE ROW LEVEL SECURITY;

-- Intentionally no RLS policies: authenticated/anon clients cannot read or write.
-- Netlify functions use the service role, which bypasses RLS.

REVOKE ALL ON public.ci_ship_class_facility_templates FROM anon;
REVOKE ALL ON public.ci_ship_class_facility_templates FROM authenticated;
GRANT ALL ON public.ci_ship_class_facility_templates TO service_role;
