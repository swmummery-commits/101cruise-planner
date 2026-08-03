-- Pre-migration audit: newsletter numbers with conflicting publication dates.
-- Run in Supabase SQL editor BEFORE applying 20260803_newsletters_table.sql.
--
-- Expected: zero rows. Any row returned must be resolved manually before migrating.

SELECT
  fc.newsletter_number,
  fc.newsletter_publication_date AS distinct_date,
  COUNT(*) AS cruise_count
FROM public.featured_cruises fc
WHERE fc.newsletter_number IS NOT NULL
  AND fc.newsletter_publication_date IS NOT NULL
GROUP BY fc.newsletter_number, fc.newsletter_publication_date
HAVING fc.newsletter_number IN (
  SELECT inner_fc.newsletter_number
  FROM public.featured_cruises inner_fc
  WHERE inner_fc.newsletter_number IS NOT NULL
    AND inner_fc.newsletter_publication_date IS NOT NULL
  GROUP BY inner_fc.newsletter_number
  HAVING COUNT(DISTINCT inner_fc.newsletter_publication_date) > 1
)
ORDER BY fc.newsletter_number, fc.newsletter_publication_date;

-- Summary: one row per conflicting newsletter number
SELECT
  fc.newsletter_number,
  COUNT(DISTINCT fc.newsletter_publication_date) AS distinct_date_count,
  COUNT(*) AS total_cruises_with_dates
FROM public.featured_cruises fc
WHERE fc.newsletter_number IS NOT NULL
  AND fc.newsletter_publication_date IS NOT NULL
GROUP BY fc.newsletter_number
HAVING COUNT(DISTINCT fc.newsletter_publication_date) > 1
ORDER BY fc.newsletter_number;
