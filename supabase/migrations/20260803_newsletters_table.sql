-- Newsletter-first workflow: normalised newsletters table + cruise FK.
-- Idempotent. Preserves existing newsletter_number/date on featured_cruises for compatibility.

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

-- =========================================================
-- newsletters
-- =========================================================

CREATE TABLE IF NOT EXISTS public.newsletters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  newsletter_number integer NOT NULL,
  newsletter_date date NULL,
  design_template text NOT NULL DEFAULT 'green-price-cards',
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT newsletters_number_positive CHECK (newsletter_number >= 1),
  CONSTRAINT newsletters_design_template_check
    CHECK (design_template IN ('green-price-cards', 'classic-editorial'))
);

CREATE UNIQUE INDEX IF NOT EXISTS newsletters_number_uidx
  ON public.newsletters (newsletter_number);

CREATE INDEX IF NOT EXISTS newsletters_date_idx
  ON public.newsletters (newsletter_date DESC NULLS LAST);

DROP TRIGGER IF EXISTS newsletters_set_updated_at ON public.newsletters;
CREATE TRIGGER newsletters_set_updated_at
  BEFORE UPDATE ON public.newsletters
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at_timestamp();

ALTER TABLE public.newsletters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can select newsletters" ON public.newsletters;
CREATE POLICY "Admins can select newsletters"
  ON public.newsletters
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can insert newsletters" ON public.newsletters;
CREATE POLICY "Admins can insert newsletters"
  ON public.newsletters
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins can update newsletters" ON public.newsletters;
CREATE POLICY "Admins can update newsletters"
  ON public.newsletters
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

DROP POLICY IF EXISTS "Admins can delete newsletters" ON public.newsletters;
CREATE POLICY "Admins can delete newsletters"
  ON public.newsletters
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.is_admin = true
    )
  );

-- =========================================================
-- featured_cruises.newsletter_id FK
-- =========================================================

ALTER TABLE public.featured_cruises
  ADD COLUMN IF NOT EXISTS newsletter_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'featured_cruises_newsletter_id_fkey'
  ) THEN
    ALTER TABLE public.featured_cruises
      ADD CONSTRAINT featured_cruises_newsletter_id_fkey
      FOREIGN KEY (newsletter_id)
      REFERENCES public.newsletters (id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS featured_cruises_newsletter_id_idx
  ON public.featured_cruises (newsletter_id);

-- =========================================================
-- Backfill newsletters from existing featured_cruises rows
-- Requires: run scripts/audit-newsletter-date-conflicts.sql first (expect 0 conflict rows).
-- Uses the single distinct date when unambiguous; NULL when cruises have no dates or only conflicts blocked above.
-- Does not modify featured_cruises.newsletter_publication_date values.
-- =========================================================

DO $$
DECLARE
  conflict_count integer;
BEGIN
  SELECT COUNT(*) INTO conflict_count
  FROM (
    SELECT fc.newsletter_number
    FROM public.featured_cruises fc
    WHERE fc.newsletter_number IS NOT NULL
      AND fc.newsletter_publication_date IS NOT NULL
    GROUP BY fc.newsletter_number
    HAVING COUNT(DISTINCT fc.newsletter_publication_date) > 1
  ) AS conflicts;

  IF conflict_count > 0 THEN
    RAISE EXCEPTION
      'Newsletter migration blocked: % newsletter number(s) have conflicting newsletter_publication_date values. Run scripts/audit-newsletter-date-conflicts.sql, resolve conflicts, then re-apply this migration.',
      conflict_count;
  END IF;
END $$;

INSERT INTO public.newsletters (newsletter_number, newsletter_date, design_template)
SELECT
  grouped.newsletter_number,
  grouped.newsletter_date,
  'green-price-cards'
FROM (
  SELECT
    fc.newsletter_number,
    CASE
      WHEN COUNT(DISTINCT fc.newsletter_publication_date) FILTER (WHERE fc.newsletter_publication_date IS NOT NULL) = 1
        THEN MAX(fc.newsletter_publication_date)
      ELSE NULL
    END AS newsletter_date
  FROM public.featured_cruises fc
  WHERE fc.newsletter_number IS NOT NULL
  GROUP BY fc.newsletter_number
) AS grouped
ON CONFLICT (newsletter_number) DO NOTHING;

UPDATE public.featured_cruises fc
SET newsletter_id = n.id
FROM public.newsletters n
WHERE fc.newsletter_number = n.newsletter_number
  AND fc.newsletter_id IS NULL;

COMMENT ON TABLE public.newsletters IS
  'Newsletter issues. Cruises reference newsletters.id; newsletter_number/date on featured_cruises remain synced for legacy queries.';

COMMENT ON COLUMN public.featured_cruises.newsletter_id IS
  'FK to newsletters.id. newsletter_number and newsletter_publication_date are kept in sync for backward compatibility.';
