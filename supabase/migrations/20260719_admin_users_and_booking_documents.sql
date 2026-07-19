-- Sprint 8: explicit Admin allow-list + booking document library metadata.
-- Safe to re-run. Does not remove profiles.is_admin (rollback-friendly).
-- Does not migrate Base44 file bytes into Storage.

-- =========================================================
-- 1. Admin users allow-list
-- =========================================================

CREATE TABLE IF NOT EXISTS public.admin_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  email text NOT NULL,
  display_name text NULL,
  role text NOT NULL DEFAULT 'admin',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT admin_users_role_check CHECK (role IN ('owner', 'admin')),
  CONSTRAINT admin_users_email_not_blank CHECK (length(trim(email)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS admin_users_email_uidx
  ON public.admin_users (lower(trim(email)));

CREATE UNIQUE INDEX IF NOT EXISTS admin_users_auth_user_uidx
  ON public.admin_users (auth_user_id)
  WHERE auth_user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.set_admin_users_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = timezone('utc', now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS admin_users_set_updated_at ON public.admin_users;
CREATE TRIGGER admin_users_set_updated_at
  BEFORE UPDATE ON public.admin_users
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_admin_users_updated_at();

ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can select admin_users" ON public.admin_users;
CREATE POLICY "Admins can select admin_users"
  ON public.admin_users
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.is_admin = true
    )
  );

-- No public insert/update/delete via anon/authenticated client.
-- Manage rows with service role / SQL editor.

-- =========================================================
-- 2. Booking documents (Base44 + Admin managed library)
-- =========================================================

CREATE TABLE IF NOT EXISTS public.booking_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_reference text NULL,
  base44_booking_id text NULL,
  base44_document_id text NULL,
  document_type text NOT NULL DEFAULT 'Other',
  filename text NULL,
  file_url text NULL,
  storage_path text NULL,
  note text NULL,
  note_visible_to_customer boolean NOT NULL DEFAULT true,
  document_visible_to_customer boolean NOT NULL DEFAULT true,
  uploaded_at timestamptz NULL,
  uploaded_by text NULL,
  source_system text NOT NULL DEFAULT 'base44',
  sync_key text NOT NULL,
  last_synced_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT booking_documents_source_check
    CHECK (source_system IN ('base44', 'admin', 'customer')),
  CONSTRAINT booking_documents_type_not_blank
    CHECK (length(trim(document_type)) > 0),
  CONSTRAINT booking_documents_sync_key_not_blank
    CHECK (length(trim(sync_key)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS booking_documents_sync_key_uidx
  ON public.booking_documents (sync_key);

CREATE UNIQUE INDEX IF NOT EXISTS booking_documents_base44_id_uidx
  ON public.booking_documents (base44_document_id)
  WHERE base44_document_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS booking_documents_booking_ref_idx
  ON public.booking_documents (booking_reference);

CREATE INDEX IF NOT EXISTS booking_documents_base44_booking_idx
  ON public.booking_documents (base44_booking_id);

CREATE INDEX IF NOT EXISTS booking_documents_visible_idx
  ON public.booking_documents (document_visible_to_customer, booking_reference);

CREATE OR REPLACE FUNCTION public.set_booking_documents_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = timezone('utc', now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS booking_documents_set_updated_at ON public.booking_documents;
CREATE TRIGGER booking_documents_set_updated_at
  BEFORE UPDATE ON public.booking_documents
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_booking_documents_updated_at();

ALTER TABLE public.booking_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can select booking_documents" ON public.booking_documents;
CREATE POLICY "Admins can select booking_documents"
  ON public.booking_documents
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can insert booking_documents" ON public.booking_documents;
CREATE POLICY "Admins can insert booking_documents"
  ON public.booking_documents
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can update booking_documents" ON public.booking_documents;
CREATE POLICY "Admins can update booking_documents"
  ON public.booking_documents
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.is_admin = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can delete booking_documents" ON public.booking_documents;
CREATE POLICY "Admins can delete booking_documents"
  ON public.booking_documents
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.is_admin = true
    )
    AND source_system = 'admin'
  );

-- Customer/browser clients do not read this table directly.
-- My Cruise uses a Netlify function with the service role.

-- =========================================================
-- 3. Seed allow-list from existing admin profiles (Steve)
-- =========================================================
-- Preserves current access: every profiles.is_admin user becomes an
-- active admin_users row. First matched email is role 'owner'.
-- Paul's email is NOT hard-coded — add him via Supabase after invite.

INSERT INTO public.admin_users (auth_user_id, email, display_name, role, active)
SELECT
  p.id,
  lower(trim(u.email)),
  COALESCE(NULLIF(trim(u.raw_user_meta_data->>'full_name'), ''), split_part(u.email, '@', 1)),
  'admin',
  true
FROM public.profiles p
JOIN auth.users u ON u.id = p.id
WHERE p.is_admin = true
  AND u.email IS NOT NULL
  AND length(trim(u.email)) > 0
  AND NOT EXISTS (
    SELECT 1
    FROM public.admin_users a
    WHERE a.auth_user_id = p.id
       OR lower(trim(a.email)) = lower(trim(u.email))
  );

-- Promote the earliest seeded/existing admin to owner if none exists yet (Steve).
UPDATE public.admin_users
SET role = 'owner'
WHERE id = (
  SELECT id
  FROM public.admin_users
  ORDER BY created_at ASC NULLS LAST, email ASC
  LIMIT 1
)
AND NOT EXISTS (
  SELECT 1 FROM public.admin_users WHERE role = 'owner'
);

-- =========================================================
-- 4. Private Storage bucket for Admin-origin booking documents
-- =========================================================
-- Safe if storage schema is unavailable (skipped silently via DO block).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'storage' AND table_name = 'buckets'
  ) THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'booking-documents',
      'booking-documents',
      false,
      10485760,
      ARRAY[
        'application/pdf',
        'image/jpeg',
        'image/png',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      ]::text[]
    )
    ON CONFLICT (id) DO NOTHING;
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'booking-documents storage bucket skipped: %', SQLERRM;
END $$;

-- Rollback notes:
--   DROP TABLE IF EXISTS public.booking_documents;
--   DROP TABLE IF EXISTS public.admin_users;
--   profiles.is_admin remains the previous access gate.
