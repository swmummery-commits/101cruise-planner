/**
 * Carnival Cruise Line — controlled production batch selection and frozen manifest.
 */

const crypto = require("crypto");
const {
  officialSailingId,
  officialProductKey,
  immutableIdentitySnapshot,
  ADAPTER_ID,
  ADAPTER_VERSION
} = require("./carnival-discovery-adapter");
const { SOURCE_ID } = require("./carnival-discovery-source");
const { daysUntilDeparture, PUBLIC_BOOKING_CUTOFF_DAYS } = require("./public-discovered-cruise-inventory");
const { evaluateCarnivalStructuredSourceTrust } = require("./carnival-structured-source-trust");

const CCL_LINE_ID = "dfc49fc6-42ed-44fa-b52a-0a48dd8fc6b6";
const CCL_LINE_SLUG = "carnival-cruise-line";
const MAX_CONTROLLED_CCL_BATCH = 20;
const APPLY_CONFIRMATION = "CARNIVAL-FIRST-CONTROLLED-BATCH";
const MANIFEST_MODE = "carnival_controlled_batch";

function candidateSortKey(row) {
  const dep = row.candidate?.departure_date || row.raw?.departure_date || "";
  const id = officialSailingId(row.raw) || "";
  return `${dep}|${id}`;
}

function isControlledBatchEligible(row, today) {
  if (!row?.eligibility?.discovery_ready) return false;
  const sailingId = officialSailingId(row.raw);
  if (!sailingId) return false;

  const days =
    row.days_until_departure != null
      ? row.days_until_departure
      : daysUntilDeparture(row.candidate?.departure_date, today);
  if (days == null || days <= PUBLIC_BOOKING_CUTOFF_DAYS) return false;

  const trust = evaluateCarnivalStructuredSourceTrust({
    structured_source: SOURCE_ID,
    sailing_id: sailingId,
    itinerary_code: row.raw?.itinerary_code,
    ship_code: row.raw?.ship_code,
    departure_date: row.candidate?.departure_date,
    nights: row.candidate?.nights,
    raw_extract: row.candidate?.raw_extract,
    shipResolution: row.ship_resolution,
    destination_id: row.candidate?.destination_id,
    destinationResolution: row.destination_resolution,
    departure_port_meta: row.candidate?.departure_port_meta
  });
  if (!trust.trusted || !trust.reference_resolution_ready) return false;
  return true;
}

function selectControlledBatchProducts(products, { maxWrites = MAX_CONTROLLED_CCL_BATCH, today, excludeSailingIds = new Set() } = {}) {
  const eligible = (products || [])
    .filter((row) => isControlledBatchEligible(row, today))
    .filter((row) => !excludeSailingIds.has(officialSailingId(row.raw)))
    .sort((a, b) => candidateSortKey(a).localeCompare(candidateSortKey(b)));

  return {
    eligible_total: eligible.length,
    selected: eligible.slice(0, maxWrites),
    excluded_sailing_ids: [...excludeSailingIds]
  };
}

function computeManifestHash(manifest) {
  const basis = JSON.stringify({
    mode: manifest.mode,
    cruise_line_id: manifest.cruise_line_id,
    expected_record_count: manifest.expected_record_count,
    entries: (manifest.entries || []).map((entry) => ({
      official_sailing_id: entry.official_sailing_id,
      itinerary_code: entry.itinerary_code,
      ship_code: entry.ship_code,
      departure_date: entry.departure_date,
      nights: entry.nights,
      proposed_action: entry.proposed_action
    }))
  });
  return crypto.createHash("sha256").update(basis).digest("hex");
}

function buildFrozenManifest({ selected, cruiseLine, entries, runId, codeSha, today }) {
  const manifest = {
    generated_at: new Date().toISOString(),
    mode: MANIFEST_MODE,
    run_id: runId || null,
    code_sha: codeSha || null,
    adapter_id: ADAPTER_ID,
    adapter_version: ADAPTER_VERSION,
    structured_source: SOURCE_ID,
    cruise_line_id: cruiseLine.id,
    cruise_line_slug: cruiseLine.slug,
    as_of_date: today,
    max_batch_size: MAX_CONTROLLED_CCL_BATCH,
    expected_record_count: entries.length,
    apply_confirmation: APPLY_CONFIRMATION,
    entries
  };
  manifest.manifest_hash = computeManifestHash(manifest);
  manifest.pinned_official_sailing_ids = entries.map((entry) => entry.official_sailing_id);
  return manifest;
}

function validateFrozenManifest(manifest, options = {}) {
  const failures = [];
  const expectedCount = options.expectedCount ?? MAX_CONTROLLED_CCL_BATCH;
  const entries = manifest?.entries || [];

  if (manifest?.mode !== MANIFEST_MODE) failures.push("invalid_manifest_mode");
  if (manifest?.cruise_line_id !== CCL_LINE_ID) failures.push("cruise_line_mismatch");
  if (entries.length !== expectedCount) failures.push(`expected_${expectedCount}_entries:${entries.length}`);
  if (Number(manifest?.max_batch_size) !== MAX_CONTROLLED_CCL_BATCH) failures.push("batch_size_cap_exceeded");
  if (manifest?.manifest_hash !== computeManifestHash(manifest)) failures.push("manifest_hash_mismatch");

  const ids = entries.map((entry) => entry.official_sailing_id).filter(Boolean);
  if (new Set(ids).size !== ids.length) failures.push("duplicate_official_sailing_ids_in_manifest");

  return { ok: failures.length === 0, failures, entries, expectedCount };
}

function revalidateManifestAgainstSource(manifest, productsBySailingId) {
  const failures = [];
  for (const entry of manifest.entries || []) {
    const live = productsBySailingId.get(entry.official_sailing_id);
    if (!live) {
      failures.push({ official_sailing_id: entry.official_sailing_id, issue: "missing_from_live_source" });
      continue;
    }
    const liveSnapshot = immutableIdentitySnapshot(live.raw);
    const pinnedSnapshot = entry.source_snapshot || immutableIdentitySnapshot(entry.raw || {});
    if (JSON.stringify(liveSnapshot) !== JSON.stringify(pinnedSnapshot)) {
      failures.push({
        official_sailing_id: entry.official_sailing_id,
        issue: "identity_snapshot_changed",
        pinned: pinnedSnapshot,
        live: liveSnapshot
      });
    }
    if (!live.eligibility?.discovery_ready) {
      failures.push({ official_sailing_id: entry.official_sailing_id, issue: "no_longer_discovery_ready" });
    }
    const days =
      live.days_until_departure != null
        ? live.days_until_departure
        : daysUntilDeparture(live.candidate?.departure_date, manifest.as_of_date);
    if (days == null || days <= PUBLIC_BOOKING_CUTOFF_DAYS) {
      failures.push({ official_sailing_id: entry.official_sailing_id, issue: "within_21_day_cutoff" });
    }
  }
  return { ok: failures.length === 0, failures };
}

function evaluatePreApplyQualityGate(simulation) {
  const metrics = simulation?.quality_gate_metrics || {};
  const gates = {
    ship: (metrics.ship_resolution_pct || 0) >= 98,
    port: (metrics.departure_port_resolution_pct || 0) >= 95,
    destination: (metrics.destination_resolution_pct || 0) >= 90,
    identity: (metrics.identity_coverage_pct || 0) >= 100,
    duplicate_identities: (metrics.duplicate_official_identities || 0) === 0
  };
  const failures = Object.entries(gates)
    .filter(([, ok]) => !ok)
    .map(([key]) => key);
  return { ok: failures.length === 0, gates, failures, metrics };
}

module.exports = {
  CCL_LINE_ID,
  CCL_LINE_SLUG,
  MAX_CONTROLLED_CCL_BATCH,
  APPLY_CONFIRMATION,
  MANIFEST_MODE,
  candidateSortKey,
  isControlledBatchEligible,
  selectControlledBatchProducts,
  computeManifestHash,
  buildFrozenManifest,
  validateFrozenManifest,
  revalidateManifestAgainstSource,
  evaluatePreApplyQualityGate
};
