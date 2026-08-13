/**
 * Royal Caribbean weekly maintenance — frozen manifest builder and validation.
 */

const crypto = require("crypto");
const { ROYAL_CARIBBEAN_WEEKLY_WRITE_CEILING } = require("./royal-caribbean-weekly-health");

const WEEKLY_MANIFEST_MODE = "royal_caribbean_weekly_maintenance";
const WEEKLY_APPLY_CONFIRMATION_TOKEN = "ROYAL-CARIBBEAN-WEEKLY-MAINTENANCE";

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function computeManifestHash(manifest) {
  const payload = {
    mode: manifest?.mode || WEEKLY_MANIFEST_MODE,
    perth_today: manifest?.perth_today || null,
    first_activation_cycle: manifest?.first_activation_cycle === true,
    source_snapshot_id: manifest?.source_snapshot_id || null,
    inserts: (manifest?.inserts || []).map((row) => ({
      official_sailing_id: row.official_sailing_id,
      identity_key: row.identity_key || null,
      proposed_action: row.proposed_action || "insert_active"
    })),
    updates: (manifest?.updates || []).map((row) => ({
      official_sailing_id: row.official_sailing_id,
      safe_fields: [...(row.safe_fields || [])].sort()
    })),
    cutoff_hides: (manifest?.cutoff_hides || []).map((row) => ({
      id: row.id,
      official_sailing_id: row.official_sailing_id
    })),
    source_absence_hides: (manifest?.source_absence_hides || []).map((row) => ({
      discovered_cruise_id: row.discovered_cruise_id || row.id,
      official_sailing_id: row.official_sailing_id
    }))
  };
  return crypto.createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function assertWeeklyCeilings(manifest, { firstActivationCycle = false } = {}) {
  const inserts = (manifest?.inserts || []).length;
  const updates = (manifest?.updates || []).length;
  const sourceAbsenceHides = (manifest?.source_absence_hides || []).length;
  const cutoffHides = (manifest?.cutoff_hides || []).length;
  const total = inserts + updates + sourceAbsenceHides + cutoffHides;
  const ceiling = ROYAL_CARIBBEAN_WEEKLY_WRITE_CEILING;
  const failures = [];

  if (inserts > ceiling.max_proposed_inserts) failures.push("insert_ceiling_exceeded");
  if (updates > ceiling.max_proposed_updates) failures.push("update_ceiling_exceeded");
  if (sourceAbsenceHides > ceiling.max_source_absent_actions) failures.push("source_absence_ceiling_exceeded");
  if (total > ceiling.max_total_proposed_changes) failures.push("total_change_ceiling_exceeded");
  if (firstActivationCycle && sourceAbsenceHides > 0) {
    failures.push("first_activation_cycle_source_absence_hides_forbidden");
  }

  return {
    ok: failures.length === 0,
    failures,
    counts: { inserts, updates, source_absence_hides: sourceAbsenceHides, cutoff_hides: cutoffHides, total },
    ceiling
  };
}

function validateFrozenWeeklyManifest(manifest, options = {}) {
  const failures = [];
  const expectedHash = options.expectedHash || null;
  const firstActivationCycle =
    options.firstActivationCycle ?? manifest?.first_activation_cycle === true;

  if (!manifest || manifest.mode !== WEEKLY_MANIFEST_MODE) {
    failures.push("invalid_weekly_manifest_mode");
  }
  if (!manifest?.perth_today) failures.push("missing_perth_today");
  if (!manifest?.source_snapshot_id) failures.push("missing_source_snapshot_id");

  const insertIds = (manifest?.inserts || []).map((row) => row.official_sailing_id).filter(Boolean);
  if (new Set(insertIds).size !== insertIds.length) failures.push("duplicate_insert_official_sailing_ids");

  const updateIds = (manifest?.updates || []).map((row) => row.official_sailing_id).filter(Boolean);
  if (new Set(updateIds).size !== updateIds.length) failures.push("duplicate_update_official_sailing_ids");

  const hideIds = (manifest?.cutoff_hides || []).map((row) => row.id).filter(Boolean);
  if (new Set(hideIds).size !== hideIds.length) failures.push("duplicate_cutoff_hide_ids");

  if (firstActivationCycle && (manifest?.source_absence_hides || []).length > 0) {
    failures.push("first_activation_cycle_source_absence_hides_forbidden");
  }

  const ceilings = assertWeeklyCeilings(manifest, { firstActivationCycle });
  if (!ceilings.ok) failures.push(...ceilings.failures);

  if (expectedHash && manifest?.manifest_hash !== expectedHash) failures.push("manifest_hash_mismatch");
  if (expectedHash && computeManifestHash(manifest) !== expectedHash) {
    failures.push("manifest_hash_recompute_mismatch");
  }

  return {
    passed: failures.length === 0,
    failures,
    ceilings,
    first_activation_cycle: firstActivationCycle
  };
}

function buildRoyalCaribbeanWeeklyManifestFromDryRun({
  dryRunResult,
  today,
  firstActivationCycle = false
}) {
  const summary = dryRunResult?.summary || {};
  const manifestProducts = dryRunResult?.manifest?.products || [];
  const updateAnalysis = summary.update_analysis || {};
  const sourceAbsencePolicy = summary.source_absence_policy || {};
  const productBySailingId = new Map(
    manifestProducts.filter((row) => row.stable_identity_key).map((row) => [row.stable_identity_key, row])
  );

  const inserts = manifestProducts
    .filter((row) => row.proposed_action === "insert_active")
    .map((row) => ({
      official_sailing_id: row.stable_identity_key,
      identity_key: row.candidate?.identity_key || row.identity_key || null,
      external_key: row.candidate?.external_key || row.external_key || null,
      proposed_action: "insert_active",
      candidate: row.candidate || null
    }));

  const safeUpdates = (updateAnalysis.safe_proposed_updates || []).map((row) => {
    const product = productBySailingId.get(row.official_sailing_id);
    return {
      official_sailing_id: row.official_sailing_id,
      safe_fields: row.safe_fields || [],
      changed_fields: row.changed_fields || [],
      proposed_action: "proposed_safe_update",
      candidate: product?.candidate || null
    };
  });

  const reviewRequired = (updateAnalysis.review_required_updates || []).map((row) => ({
    official_sailing_id: row.official_sailing_id,
    review_required_fields: row.review_required_fields || [],
    proposed_action: "review_required_update"
  }));

  const cutoffHides = (summary.production_cutoff_candidates || []).map((row) => ({
    id: row.id,
    official_sailing_id: row.official_sailing_id,
    departure_date: row.departure_date || null,
    proposed_action: "hide_from_public_inventory"
  }));

  const sourceAbsenceObservations = (sourceAbsencePolicy.source_absent_candidates || []).map((row) => ({
    discovered_cruise_id: row.discovered_cruise_id || null,
    official_sailing_id: row.official_sailing_id,
    classification: row.classification || "source_absent_candidate",
    proposed_action: "retain_active"
  }));

  const sourceAbsenceHides = firstActivationCycle
    ? []
    : (sourceAbsencePolicy.source_absent_action_eligible || []).map((row) => ({
        discovered_cruise_id: row.discovered_cruise_id || null,
        official_sailing_id: row.official_sailing_id,
        proposed_action: "hide_source_absent"
      }));

  const weeklyManifest = {
    generated_at: new Date().toISOString(),
    mode: WEEKLY_MANIFEST_MODE,
    confirm_token: WEEKLY_APPLY_CONFIRMATION_TOKEN,
    perth_today: today,
    first_activation_cycle: firstActivationCycle === true,
    source_snapshot_id: summary.source_snapshot_id || null,
    run_id: summary.run_id || null,
    inserts,
    updates: safeUpdates,
    cutoff_hides: cutoffHides,
    source_absence_observations: sourceAbsenceObservations,
    source_absence_hides: sourceAbsenceHides,
    review_required: reviewRequired,
    writes_performed: false,
    actual_writes: 0
  };

  weeklyManifest.manifest_hash = computeManifestHash(weeklyManifest);
  return weeklyManifest;
}

module.exports = {
  WEEKLY_MANIFEST_MODE,
  WEEKLY_APPLY_CONFIRMATION_TOKEN,
  buildRoyalCaribbeanWeeklyManifestFromDryRun,
  computeManifestHash,
  validateFrozenWeeklyManifest,
  assertWeeklyCeilings
};
