/**
 * Carnival Cruise Line — full production catch-up (frozen master manifest + 250-record chunks).
 */

const crypto = require("crypto");
const {
  officialSailingId,
  immutableIdentitySnapshot,
  ADAPTER_ID,
  ADAPTER_VERSION
} = require("./carnival-discovery-adapter");
const { SOURCE_ID } = require("./carnival-discovery-source");
const {
  CCL_LINE_ID,
  CCL_LINE_SLUG,
  candidateSortKey,
  isControlledBatchEligible,
  computeManifestHash,
  evaluatePreApplyQualityGate
} = require("./carnival-controlled-batch");
const { daysUntilDeparture } = require("./public-discovered-cruise-inventory");

const MAX_CCL_CATCHUP_CHUNK = 250;
const CATCHUP_CONFIRM_TOKEN = "CARNIVAL-FULL-CATCHUP";
const CATCHUP_MASTER_MODE = "carnival_full_catchup_master";
const CATCHUP_CHUNK_MODE = "carnival_full_catchup_chunk";

function computeSourceSnapshotId(simulation) {
  const basis = JSON.stringify({
    raw_groups: simulation?.fetch_result?.raw_group_count,
    unique_groups: simulation?.fetch_result?.unique_group_count,
    unique_sailings: simulation?.products?.length,
    cutoff_eligible: simulation?.readiness_funnel?.cutoff_eligible,
    quality_gate_metrics: simulation?.quality_gate_metrics
  });
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

function selectCatchupCandidates(products, { excludeSailingIds = new Set(), today } = {}) {
  const excluded = new Set([...(excludeSailingIds || [])].map(String));
  const eligible = (products || [])
    .filter((row) => isControlledBatchEligible(row, today))
    .filter((row) => !excluded.has(officialSailingId(row.raw)))
    .sort((a, b) => candidateSortKey(a).localeCompare(candidateSortKey(b)));

  return {
    selected: eligible,
    eligible_count: eligible.length,
    excluded_existing_count: excluded.size
  };
}

function buildMasterManifest({
  entries,
  cruiseLine,
  catchupId,
  sourceSnapshotId,
  sourceFetchedAt,
  today,
  codeSha
}) {
  const manifest = {
    catchup_id: catchupId,
    generated_at: new Date().toISOString(),
    mode: CATCHUP_MASTER_MODE,
    cruise_line_id: cruiseLine.id,
    cruise_line_slug: CCL_LINE_SLUG,
    structured_source: SOURCE_ID,
    adapter_id: ADAPTER_ID,
    adapter_version: ADAPTER_VERSION,
    expected_record_count: entries.length,
    confirm_token: CATCHUP_CONFIRM_TOKEN,
    public_eligibility_rule: ">21_days_before_departure",
    perth_today: today,
    code_sha: codeSha || null,
    source_snapshot_id: sourceSnapshotId,
    source_fetched_at: sourceFetchedAt,
    max_chunk_size: MAX_CCL_CATCHUP_CHUNK,
    writes_performed: false,
    actual_writes: 0,
    entries
  };
  manifest.manifest_hash = computeManifestHash(manifest);
  manifest.chunks = splitMasterIntoChunks(manifest).chunk_plan;
  return manifest;
}

function splitMasterIntoChunks(masterManifest) {
  const entries = [...(masterManifest.entries || [])]
    .map((e) => JSON.parse(JSON.stringify(e)))
    .sort((a, b) => String(a.official_sailing_id).localeCompare(String(b.official_sailing_id)));
  const chunks = [];
  for (let i = 0; i < entries.length; i += MAX_CCL_CATCHUP_CHUNK) {
    const slice = entries.slice(i, i + MAX_CCL_CATCHUP_CHUNK);
    const chunkNumber = chunks.length + 1;
    const chunkManifest = {
      catchup_id: masterManifest.catchup_id,
      generated_at: masterManifest.generated_at,
      mode: CATCHUP_CHUNK_MODE,
      master_manifest_hash: masterManifest.manifest_hash,
      chunk_number: chunkNumber,
      chunk_count: null,
      cruise_line_id: masterManifest.cruise_line_id,
      expected_record_count: slice.length,
      max_batch_size: MAX_CCL_CATCHUP_CHUNK,
      confirm_token: CATCHUP_CONFIRM_TOKEN,
      perth_today: masterManifest.perth_today,
      source_snapshot_id: masterManifest.source_snapshot_id,
      code_sha: masterManifest.code_sha,
      entries: slice
    };
    chunkManifest.manifest_hash = computeManifestHash(chunkManifest);
    chunks.push({
      chunk_number: chunkNumber,
      record_count: slice.length,
      manifest_hash: chunkManifest.manifest_hash,
      first_official_sailing_id: slice[0]?.official_sailing_id || null,
      last_official_sailing_id: slice[slice.length - 1]?.official_sailing_id || null,
      manifest: chunkManifest
    });
  }
  const chunkCount = chunks.length;
  for (const c of chunks) {
    c.manifest.chunk_count = chunkCount;
    c.chunk_count = chunkCount;
  }
  return {
    chunks,
    chunk_plan: chunks.map(({ chunk_number, record_count, manifest_hash, first_official_sailing_id, last_official_sailing_id }) => ({
      chunk_number,
      record_count,
      manifest_hash,
      first_official_sailing_id,
      last_official_sailing_id
    }))
  };
}

function validateMasterManifest(manifest, { expectedHash = null, today = null } = {}) {
  const failures = [];
  const entries = manifest?.entries || [];
  const perthToday = today || manifest?.perth_today;

  if (manifest?.mode !== CATCHUP_MASTER_MODE) failures.push(`invalid_mode:${manifest?.mode}`);
  if (manifest?.cruise_line_id !== CCL_LINE_ID) failures.push("cruise_line_mismatch");
  if (!entries.length) failures.push("empty_master_manifest");

  const sailingIds = entries.map((e) => e.official_sailing_id).filter(Boolean);
  if (new Set(sailingIds).size !== sailingIds.length) failures.push("duplicate_official_sailing_ids");

  for (const entry of entries) {
    const days = entry.departure_date ? daysUntilDeparture(entry.departure_date, perthToday) : null;
    if (days != null && days <= 21) failures.push(`within_21_day_cutoff:${entry.official_sailing_id}`);
    if (!["insert_active", "update_official_match"].includes(entry.proposed_action)) {
      failures.push(`unexpected_action:${entry.official_sailing_id}:${entry.proposed_action}`);
    }
  }

  if (expectedHash && manifest.manifest_hash !== expectedHash) failures.push("manifest_hash_mismatch");
  if (manifest.manifest_hash !== computeManifestHash(manifest)) failures.push("manifest_hash_recompute_mismatch");

  return { passed: failures.length === 0, failures };
}

function validateCatchupChunk(chunkManifest, masterManifest, { expectedHash = null, today = null } = {}) {
  const failures = [];
  const entries = chunkManifest?.entries || [];
  const perthToday = today || chunkManifest?.perth_today;

  if (chunkManifest?.mode !== CATCHUP_CHUNK_MODE) failures.push(`invalid_chunk_mode:${chunkManifest?.mode}`);
  if (chunkManifest?.master_manifest_hash !== masterManifest?.manifest_hash) failures.push("master_manifest_hash_mismatch");
  if (entries.length === 0) failures.push("empty_chunk");
  if (entries.length > MAX_CCL_CATCHUP_CHUNK) failures.push(`chunk_exceeds_max:${entries.length}`);
  if (expectedHash && chunkManifest.manifest_hash !== expectedHash) failures.push("chunk_hash_mismatch");

  const masterIds = new Set((masterManifest.entries || []).map((e) => e.official_sailing_id));
  for (const entry of entries) {
    if (!masterIds.has(entry.official_sailing_id)) failures.push(`chunk_entry_not_in_master:${entry.official_sailing_id}`);
    const days = entry.departure_date ? daysUntilDeparture(entry.departure_date, perthToday) : null;
    if (days != null && days <= 21) failures.push(`chunk_within_21_day:${entry.official_sailing_id}`);
  }

  const chunkIds = entries.map((e) => e.official_sailing_id);
  if (new Set(chunkIds).size !== chunkIds.length) failures.push("duplicate_chunk_sailing_ids");

  return { passed: failures.length === 0, failures };
}

function chunkManifestToApplyManifest(chunkManifest, runId) {
  return {
    ...chunkManifest,
    run_id: runId,
    pinned_official_sailing_ids: (chunkManifest.entries || []).map((e) => e.official_sailing_id)
  };
}

module.exports = {
  MAX_CCL_CATCHUP_CHUNK,
  CATCHUP_CONFIRM_TOKEN,
  CATCHUP_MASTER_MODE,
  CATCHUP_CHUNK_MODE,
  computeSourceSnapshotId,
  selectCatchupCandidates,
  buildMasterManifest,
  splitMasterIntoChunks,
  validateMasterManifest,
  validateCatchupChunk,
  chunkManifestToApplyManifest,
  evaluatePreApplyQualityGate
};
