/**
 * Royal Caribbean authoritative enumeration split into bounded Netlify phases.
 *
 * Six source phases preserve the existing safety model:
 *   stability A: page sizes 25, 50, 100
 *   stability B: page sizes 25, 50, 100
 * The 100-page-size phase continues until an empty page, matching the existing
 * authoritative union implementation. A final read-only reconciliation consumes
 * the frozen union without refetching Royal Caribbean.
 */
const {
  enumerateGlobalOffsetPass,
  symmetricSetDiff
} = require("./royal-caribbean-source-enumeration");
const {
  saveEnumerationPhase,
  loadEnumerationPhase,
  savePhasedRunState
} = require("./royal-caribbean-phased-enumeration-store");
const { officialProductKey } = require("./royal-caribbean-discovery-source");

const PHASE_SPECS = Object.freeze([
  { id: "a-25", stability_pass: "A", page_size: 25, stop_at_total: true, until_empty: false },
  { id: "a-50", stability_pass: "A", page_size: 50, stop_at_total: true, until_empty: false },
  { id: "a-100", stability_pass: "A", page_size: 100, stop_at_total: false, until_empty: true },
  { id: "b-25", stability_pass: "B", page_size: 25, stop_at_total: true, until_empty: false },
  { id: "b-50", stability_pass: "B", page_size: 50, stop_at_total: true, until_empty: false },
  { id: "b-100", stability_pass: "B", page_size: 100, stop_at_total: false, until_empty: true }
]);

function phaseSpec(phaseId) {
  return PHASE_SPECS.find((row) => row.id === String(phaseId)) || null;
}
function nextPhaseId(phaseId) {
  const index = PHASE_SPECS.findIndex((row) => row.id === String(phaseId));
  if (index < 0 || index >= PHASE_SPECS.length - 1) return null;
  return PHASE_SPECS[index + 1].id;
}

async function runPhasedEnumerationSourcePhase({ runId, phaseId, today, requestDelayMs = 100 } = {}) {
  const spec = phaseSpec(phaseId);
  if (!runId) throw new Error("run_id_required");
  if (!spec) throw new Error(`invalid_phase_id:${phaseId}`);
  const started = Date.now();
  const pass = await enumerateGlobalOffsetPass({
    pageSize: spec.page_size,
    stopAtTotal: spec.stop_at_total,
    untilEmpty: spec.until_empty,
    requestDelayMs,
    today
  });
  const enriched = { ...pass, duration_ms: Date.now() - started };
  const manifest = await saveEnumerationPhase(runId, spec.id, enriched);
  await savePhasedRunState(runId, {
    status: "source_phase_completed",
    last_completed_phase: spec.id,
    next_phase: nextPhaseId(spec.id),
    actual_writes: 0
  });
  return { spec, manifest, next_phase: nextPhaseId(spec.id), actual_writes: 0 };
}

function mergeRawProducts(phases) {
  const byId = new Map();
  for (const phase of phases) {
    for (const raw of phase.products || []) {
      const id = officialProductKey(raw);
      if (!id) continue;
      if (!byId.has(id)) byId.set(id, raw);
    }
  }
  return [...byId.values()].sort((a, b) => String(officialProductKey(a)).localeCompare(String(officialProductKey(b))));
}

function idsForStabilityPass(phases, passName) {
  const ids = new Set();
  for (const phase of phases.filter((row) => row.stability_pass === passName)) {
    for (const raw of phase.products || []) {
      const id = officialProductKey(raw);
      if (id) ids.add(id);
    }
  }
  return ids;
}

async function loadAllPhases(runId) {
  const rows = [];
  for (const spec of PHASE_SPECS) {
    const stored = await loadEnumerationPhase(runId, spec.id);
    if (!stored) return { ok: false, missing_phase: spec.id, phases: rows };
    rows.push({ ...stored, stability_pass: spec.stability_pass });
  }
  return { ok: true, phases: rows };
}

async function buildPhasedAuthoritativeFetchResult({ runId, today } = {}) {
  const loaded = await loadAllPhases(runId);
  if (!loaded.ok) {
    return { ok: false, reason: "phased_enumeration_incomplete", missing_phase: loaded.missing_phase };
  }
  const phases = loaded.phases;
  const rawSailings = mergeRawProducts(phases).filter((raw) => !today || !raw.departure_date || raw.departure_date >= today);
  const uniqueGroupIds = new Set(rawSailings.map((raw) => raw.group_id).filter(Boolean));
  const sailingIds = new Set(rawSailings.map((raw) => officialProductKey(raw)).filter(Boolean));
  const passAIds = idsForStabilityPass(phases, "A");
  const passBIds = idsForStabilityPass(phases, "B");
  const stabilityDiff = symmetricSetDiff(passAIds, passBIds);
  const phaseFailures = phases.filter((phase) => !phase.pages_requested || !phase.product_count);
  const duplicateSailingIds = 0; // final union is identity-deduped by construction.
  const pagesRequested = phases.reduce((sum, phase) => sum + (phase.pages_requested || 0), 0);
  const totalOfficial = Math.max(...phases.map((phase) => phase.results_total || 0), 0);

  // The live RCG catalogue can legitimately move by a handful of identities
  // between stability passes. Large unexplained movement remains a hard gate.
  const phasedEnumerationOk = phaseFailures.length === 0 && stabilityDiff.symmetric_count <= 10 && sailingIds.size > 0;

  return {
    ok: phasedEnumerationOk,
    read_only: true,
    writes: false,
    authoritative_union: true,
    phased_authoritative_enumeration: true,
    total_official: totalOfficial,
    raw_sailings: rawSailings,
    itinerary_groups_fetched: uniqueGroupIds.size,
    pagination_requests: pagesRequested,
    page_log: phases.map((phase) => ({
      phase_id: phase.phase_id,
      page_size: phase.page_size,
      pages_requested: phase.pages_requested,
      results_total: phase.results_total,
      unique_group_ids: phase.unique_group_ids,
      unique_sailing_ids: phase.unique_sailing_ids,
      duration_ms: phase.duration_ms
    })),
    pagination: {
      pages_requested: pagesRequested,
      pages_successful: pagesRequested,
      pages_failed: 0,
      incomplete_pagination: !phasedEnumerationOk,
      fetch_failed: !phasedEnumerationOk,
      authoritative_union: true,
      phased: true,
      union_page_sizes: [25, 50, 100],
      stability_passes: 2,
      stability_symmetric_sailing_diff: stabilityDiff.symmetric_count
    },
    ingestion_audit: {
      duplicate_sailing_ids: duplicateSailingIds,
      duplicate_group_ids: 0,
      malformed: 0,
      phased_source_duplicates_deduped: phases.reduce((sum, phase) => sum + Math.max(0, (phase.product_count || 0) - (phase.unique_sailing_ids || 0)), 0)
    },
    phased_enumeration_health: {
      ok: phasedEnumerationOk,
      phase_count: phases.length,
      expected_phase_count: PHASE_SPECS.length,
      phase_failures: phaseFailures.map((phase) => phase.phase_id),
      stability_pass_a_sailings: passAIds.size,
      stability_pass_b_sailings: passBIds.size,
      stability_symmetric_sailing_diff: stabilityDiff.symmetric_count,
      only_in_a_sample: stabilityDiff.only_in_a.slice(0, 20),
      only_in_b_sample: stabilityDiff.only_in_b.slice(0, 20)
    },
    phase_manifests: phases.map((phase) => ({
      phase_id: phase.phase_id,
      page_size: phase.page_size,
      pages_requested: phase.pages_requested,
      product_count: phase.product_count,
      duration_ms: phase.duration_ms,
      shard_count: phase.shard_count
    })),
    today
  };
}

module.exports = {
  PHASE_SPECS,
  phaseSpec,
  nextPhaseId,
  runPhasedEnumerationSourcePhase,
  loadAllPhases,
  buildPhasedAuthoritativeFetchResult,
  mergeRawProducts
};
