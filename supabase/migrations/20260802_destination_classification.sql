-- Sprint 11E: Decouple Discovery classification from Living Destination publication
-- DO NOT RUN without approval. Apply after code deployment.
-- Additive / safe to re-run.

-- Option B: minimal field separating internal classification from public editorial status.
-- Existing `status` (draft | published | hidden) remains the public Living Destination gate.
-- `classification_enabled` controls whether Discovery / Cruise Finder may use the row for matching.

ALTER TABLE public.destinations
  ADD COLUMN IF NOT EXISTS classification_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.destinations.classification_enabled IS
  'When true, destination may be used for Discovery matching and internal Cruise Finder classification. Independent of public Living Destination publication (status).';

COMMENT ON COLUMN public.destinations.status IS
  'Public Living Destination publication: draft (no public page), published (public page), hidden (withdrawn from public).';

CREATE INDEX IF NOT EXISTS destinations_classification_enabled_idx
  ON public.destinations (classification_enabled, status)
  WHERE classification_enabled = true;

-- Existing Alaska shell: published publicly AND classification-enabled (no change needed after default).
-- Hidden destinations remain in table but are excluded from classification by application filter (status=hidden).

-- ROLLBACK (run manually if reverting):
-- DROP INDEX IF EXISTS public.destinations_classification_enabled_idx;
-- ALTER TABLE public.destinations DROP COLUMN IF EXISTS classification_enabled;
