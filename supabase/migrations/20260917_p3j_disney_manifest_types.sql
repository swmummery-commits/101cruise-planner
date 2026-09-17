-- Allow Disney two-phase freeze/precommit and incident recovery provenance.
-- Existing production check only allowed rollback | historical_audit | dry_run.
-- Runtime still maps new logical types onto those three until this migration is applied.

ALTER TABLE public.cruise_discovery_maintenance_manifests
  DROP CONSTRAINT IF EXISTS cruise_discovery_maintenance_manifests_type_check;

ALTER TABLE public.cruise_discovery_maintenance_manifests
  ADD CONSTRAINT cruise_discovery_maintenance_manifests_type_check CHECK (
    manifest_type IN (
      'rollback',
      'historical_audit',
      'dry_run',
      'disney_source_freeze',
      'disney_precommit_batch',
      'partial_write_recovery'
    )
  );
