-- Newsletter email-asset mapping for Mailchimp File Manager uploads.
-- Idempotent. Does not modify newsletters, featured_cruises, or Storage objects.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.set_updated_at_timestamp()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = timezone('utc', now());
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.newsletter_email_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  newsletter_id uuid NOT NULL REFERENCES public.newsletters (id) ON DELETE CASCADE,
  variant_scope text NOT NULL DEFAULT 'shared',
  asset_type text NOT NULL,
  source_url text NOT NULL,
  source_url_normalized text NOT NULL,
  source_path text NULL,
  source_checksum text NOT NULL,
  mailchimp_file_id text NOT NULL,
  mailchimp_file_url text NOT NULL,
  mailchimp_folder_id text NULL,
  generated_filename text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT newsletter_email_assets_variant_scope_check
    CHECK (variant_scope IN ('shared', 'airline_staff', 'general')),
  CONSTRAINT newsletter_email_assets_asset_type_check
    CHECK (asset_type IN ('hero', 'route_map', 'other')),
  CONSTRAINT newsletter_email_assets_source_checksum_not_blank
    CHECK (length(trim(source_checksum)) > 0),
  CONSTRAINT newsletter_email_assets_mailchimp_url_https
    CHECK (mailchimp_file_url ~* '^https://'),
  CONSTRAINT newsletter_email_assets_newsletter_checksum_key
    UNIQUE (newsletter_id, source_checksum)
);

CREATE INDEX IF NOT EXISTS newsletter_email_assets_newsletter_url_idx
  ON public.newsletter_email_assets (newsletter_id, source_url_normalized);

CREATE INDEX IF NOT EXISTS newsletter_email_assets_file_id_idx
  ON public.newsletter_email_assets (mailchimp_file_id);

COMMENT ON TABLE public.newsletter_email_assets IS
  'Maps newsletter source images (Supabase) to Mailchimp File Manager copies used in exported HTML. Shared across Airline Staff and General variants. Does not delete Mailchimp or Supabase files.';

DROP TRIGGER IF EXISTS newsletter_email_assets_set_updated_at ON public.newsletter_email_assets;
CREATE TRIGGER newsletter_email_assets_set_updated_at
  BEFORE UPDATE ON public.newsletter_email_assets
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at_timestamp();

ALTER TABLE public.newsletter_email_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can select newsletter_email_assets" ON public.newsletter_email_assets;
CREATE POLICY "Admins can select newsletter_email_assets"
  ON public.newsletter_email_assets
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can insert newsletter_email_assets" ON public.newsletter_email_assets;
CREATE POLICY "Admins can insert newsletter_email_assets"
  ON public.newsletter_email_assets
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can update newsletter_email_assets" ON public.newsletter_email_assets;
CREATE POLICY "Admins can update newsletter_email_assets"
  ON public.newsletter_email_assets
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );
