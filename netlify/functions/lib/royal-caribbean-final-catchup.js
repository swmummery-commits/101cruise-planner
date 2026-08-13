/**
 * Royal Caribbean International — final production catch-up (frozen master manifest + 250-record chunks).
 */

const crypto = require("crypto");
const {
  officialProductKey,
  isRoyalCaribbeanCruisetour
} = require("./royal-caribbean-discovery-adapter");
const { daysUntilDeparture } = require("./public-discovered-cruise-inventory");
const {
  buildFrozenManifestEntry,
  computeManifestHash,
  computeSourceSnapshotId,
  isIslanRepositioningExclusion,
  RC_LINE_ID,
  RC_LINE_SLUG
} = require("./royal-caribbean-controlled-batch");
const {
  fetchRoyalCaribbeanInventoryPages,
  expandGraphGroupsToRawSailings,
  assessRoyalCaribbeanPagination,
  DEFAULT_PAGE_SIZE
} = require("./royal-caribbean-discovery-source");

const MAX_ROYAL_CARIBBEAN_CATCHUP_CHUNK = 250;
const CATCHUP_CONFIRM_TOKEN = "ROYAL-CARIBBEAN-FINAL-CATCHUP";
const CATCHUP_MASTER_MODE = "royal_caribbean_final_catchup_master";
const CATCHUP_CHUNK_MODE = "royal_caribbean_final_catchup_chunk";
const PUBLIC_ELIGIBILITY_MIN_DAYS = 22;

function isCatchupEligible(product, today) {
  if (!product || product.product_type !== "ocean_cruise") return false;
  if (isRoyalCaribbeanCruisetour(product.product_type)) return false;
  if (!product.complete_high_confidence) return false;
  if (product.status_class !== "open") return false;
  if (product.time_eligibility !== "eligible") return false;
  if (!product.ship_resolution?.resolved) return false;
  if (product.destination_resolution?.status !== "resolved") return false;
  if (isIslanRepositioningExclusion(product)) return false;
  const reasons = product?.failure_reasons || [];
  if (reasons.some((r) => r.startsWith("confidence:") && r !== "confidence:high_confidence")) return false;
  const dep = product.candidate?.departure_date || product.raw?.departure_date;
  const days = dep ? daysUntilDeparture(dep, today) : null;
  if (days == null || days <= 21) return false;
  if (!officialProductKey(product.raw)) return false;
  return true;
}

function catchupSortKey(product) {
  const dep = product.candidate?.departure_date || product.raw?.departure_date || "";
  const ship = String(product.raw?.ship_code || "").toUpperCase();
  const id = officialProductKey(product.raw) || "";
  return `${dep}|${ship}|${id}`;
}

function selectCatchupCandidates(products, { excludeSailingIds = new Set(), today } = {}) {
  const excluded = new Set([...(excludeSailingIds || [])].map(String));
  const eligible = (products || [])
    .filter((p) => isCatchupEligible(p, today))
    .filter((p) => !excluded.has(officialProductKey(p.raw)))
    .sort((a, b) => catchupSortKey(a).localeCompare(catchupSortKey(b)));

  let eligible_22_44_days = 0;
  let eligible_45_plus_days = 0;
  for (const p of eligible) {
    const dep = p.candidate?.departure_date || p.raw?.departure_date;
    const days = dep ? daysUntilDeparture(dep, today) : null;
    if (days != null && days >= 22 && days < 45) eligible_22_44_days += 1;
    else if (days != null && days >= 45) eligible_45_plus_days += 1;
  }

  return {
    selected: eligible.map((product) => ({ product, selection_reason: "catchup_deterministic" })),
    eligible_count: eligible.length,
    eligible_22_44_days,
    eligible_45_plus_days,
    excluded_existing_count: excluded.size
  };
}

function buildMasterManifest({
  selected,
  cruiseLine,
  destinations,
  catchupId,
  sourceSnapshotId,
  sourceFetchedAt,
  today
}) {
  const entries = selected.map(({ product, selection_reason }) => ({
    ...buildFrozenManifestEntry(product, cruiseLine, destinations),
    selection_reason
  }));
  const manifest = {
    catchup_id: catchupId,
    generated_at: new Date().toISOString(),
    mode: CATCHUP_MASTER_MODE,
    cruise_line_id: cruiseLine.id,
    cruise_line_slug: RC_LINE_SLUG,
    expected_record_count: entries.length,
    confirm_token: CATCHUP_CONFIRM_TOKEN,
    public_eligibility_rule: ">21_days_before_departure",
    perth_today: today,
    source_snapshot_id: sourceSnapshotId,
    source_fetched_at: sourceFetchedAt,
    max_chunk_size: MAX_ROYAL_CARIBBEAN_CATCHUP_CHUNK,
    writes_performed: false,
    actual_writes: 0,
    entries
  };
  manifest.manifest_hash = computeManifestHash(manifest);
  manifest.chunks = splitMasterIntoChunks(manifest).chunk_plan;
  return manifest;
}

function computeChunkHash(chunkManifest) {
  return computeManifestHash(chunkManifest);
}

function splitMasterIntoChunks(masterManifest) {
  const entries = [...(masterManifest.entries || [])]
    .map((e) => JSON.parse(JSON.stringify(e)))
    .sort((a, b) => String(a.official_sailing_id).localeCompare(String(b.official_sailing_id)));
  const chunks = [];
  for (let i = 0; i < entries.length; i += MAX_ROYAL_CARIBBEAN_CATCHUP_CHUNK) {
    const slice = entries.slice(i, i + MAX_ROYAL_CARIBBEAN_CATCHUP_CHUNK);
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
      max_batch_size: MAX_ROYAL_CARIBBEAN_CATCHUP_CHUNK,
      confirm_token: CATCHUP_CONFIRM_TOKEN,
      perth_today: masterManifest.perth_today,
      source_snapshot_id: masterManifest.source_snapshot_id,
      entries: slice
    };
    chunkManifest.manifest_hash = computeChunkHash(chunkManifest);
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
  return { chunks, chunk_plan: chunks.map(({ chunk_number, record_count, manifest_hash, first_official_sailing_id, last_official_sailing_id }) => ({
    chunk_number,
    record_count,
    manifest_hash,
    first_official_sailing_id,
    last_official_sailing_id
  })) };
}

function validateMasterManifest(manifest, { expectedHash = null, today = null } = {}) {
  const failures = [];
  const entries = manifest?.entries || [];
  const perthToday = today || manifest?.perth_today;

  if (manifest?.mode !== CATCHUP_MASTER_MODE) failures.push(`invalid_mode:${manifest?.mode}`);
  if (!entries.length) failures.push("empty_master_manifest");

  const sailingIds = entries.map((e) => e.official_sailing_id).filter(Boolean);
  if (new Set(sailingIds).size !== sailingIds.length) failures.push("duplicate_official_sailing_ids");
  const identityKeys = entries.map((e) => e.identity_key).filter(Boolean);
  if (new Set(identityKeys).size !== identityKeys.length) failures.push("duplicate_identity_keys");

  if (entries.some((e) => !e.resolved_ship_db_id)) failures.push("unresolved_ships");
  if (entries.some((e) => !e.resolved_embarkation_port_name)) failures.push("unresolved_embarkation_ports");
  if (entries.some((e) => !e.resolved_destination_id)) failures.push("unresolved_destinations");
  if (entries.some((e) => String(e.destination_source_code || "").toUpperCase() === "ISLAN")) {
    failures.push("islan_repositioning_present");
  }
  if (entries.some((e) => e.proposed_action !== "insert_active")) failures.push("non_insert_action_present");

  for (const entry of entries) {
    const days = entry.departure_date ? daysUntilDeparture(entry.departure_date, perthToday) : null;
    if (days != null && days <= 21) failures.push(`within_21_day_cutoff:${entry.official_sailing_id}`);
  }

  if (expectedHash && manifest.manifest_hash !== expectedHash) failures.push("manifest_hash_mismatch");

  return {
    passed: failures.length === 0,
    failures,
    gates: {
      unique_official_sailing_ids: new Set(sailingIds).size === entries.length,
      unique_identity_keys: new Set(identityKeys).size === entries.length,
      unresolved_ships_0: !entries.some((e) => !e.resolved_ship_db_id),
      unresolved_embarkation_ports_0: !entries.some((e) => !e.resolved_embarkation_port_name),
      unresolved_destinations_0: !entries.some((e) => !e.resolved_destination_id),
      within_21_day_cutoff_0: !entries.some((e) => {
        const days = e.departure_date ? daysUntilDeparture(e.departure_date, perthToday) : null;
        return days != null && days <= 21;
      }),
      manifest_hash_valid: !expectedHash || manifest.manifest_hash === expectedHash
    }
  };
}

function validateCatchupChunk(chunkManifest, masterManifest, { expectedHash = null, today = null } = {}) {
  const failures = [];
  const entries = chunkManifest?.entries || [];
  const perthToday = today || chunkManifest?.perth_today;

  if (chunkManifest?.mode !== CATCHUP_CHUNK_MODE) failures.push(`invalid_chunk_mode:${chunkManifest?.mode}`);
  if (chunkManifest?.master_manifest_hash !== masterManifest?.manifest_hash) {
    failures.push("master_manifest_hash_mismatch");
  }
  if (entries.length === 0) failures.push("empty_chunk");
  if (entries.length > MAX_ROYAL_CARIBBEAN_CATCHUP_CHUNK) {
    failures.push(`chunk_exceeds_max:${entries.length}`);
  }
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

function analyseDuplicateGroups(groups = []) {
  const byId = new Map();
  for (const group of groups) {
    const id = String(group?.id || "").trim();
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(group);
  }
  const duplicateGroupIds = [...byId.entries()].filter(([, arr]) => arr.length > 1);
  const analyses = duplicateGroupIds.map(([id, copies]) => {
    const sailingSets = copies.map((g) => {
      const expanded = expandGraphGroupsToRawSailings([g], { today: "2099-01-01", futureOnly: false });
      return (expanded.products || []).map((p) => p.official_sailing_id).sort().join("|");
    });
    const identical = sailingSets.every((s) => s === sailingSets[0]);
    return { group_id: id, copy_count: copies.length, identical_sailing_arrays: identical, sailing_signatures: sailingSets };
  });
  return {
    duplicate_group_id_count: duplicateGroupIds.length,
    duplicate_group_analyses: analyses,
    all_duplicate_groups_identical: analyses.every((a) => a.identical_sailing_arrays)
  };
}

async function comparePaginationStrategies(options = {}) {
  const pageSizeA = Number(options.pageSizeA) || DEFAULT_PAGE_SIZE;
  const pageSizeB = Number(options.pageSizeB) || 100;

  function summariseFetch(label, fetchResult, pageSize, today) {
    const groups = fetchResult.groups || [];
    const groupIds = groups.map((g) => String(g?.id || "").trim()).filter(Boolean);
    const dupAnalysis = analyseDuplicateGroups(groups);
    const expanded = expandGraphGroupsToRawSailings(groups, { today, futureOnly: true });
    const sailingIds = (expanded.products || []).map((p) => p.official_sailing_id).filter(Boolean);
    const pagination = assessRoyalCaribbeanPagination(fetchResult);
    return {
      label,
      page_size: pageSize,
      results_total: Number(fetchResult.total_official) || 0,
      pages_requested: pagination.pages_requested,
      pages_successful: pagination.pages_successful,
      pages_failed: pagination.pages_failed,
      raw_group_records: groups.length,
      unique_group_ids: new Set(groupIds).size,
      duplicate_group_ids: dupAnalysis.duplicate_group_id_count,
      duplicate_group_analyses: dupAnalysis.duplicate_group_analyses,
      unique_sailing_ids: new Set(sailingIds).size,
      sailing_ids: sailingIds,
      duplicate_sailing_ids: expanded.audit?.duplicate_sailing_ids || 0,
      incomplete_pagination: pagination.incomplete_pagination,
      ok: fetchResult.ok && !pagination.incomplete_pagination && (expanded.audit?.duplicate_sailing_ids || 0) === 0
    };
  }

  const today = options.today || new Date().toISOString().slice(0, 10);
  const fetchA = await fetchRoyalCaribbeanInventoryPages({ pageSize: pageSizeA, requestDelayMs: 150 });
  const summaryA = summariseFetch("fetch_a_default_page_size", fetchA, pageSizeA, today);
  const fetchB = await fetchRoyalCaribbeanInventoryPages({ pageSize: pageSizeB, requestDelayMs: 150 });
  const summaryB = summariseFetch("fetch_b_100_page_size", fetchB, pageSizeB, today);

  const setA = new Set(summaryA.sailing_ids);
  const setB = new Set(summaryB.sailing_ids);
  const onlyInA = [...setA].filter((id) => !setB.has(id));
  const onlyInB = [...setB].filter((id) => !setA.has(id));
  const sailingDelta = Math.abs(summaryA.unique_sailing_ids - summaryB.unique_sailing_ids);
  const symmetricDiff = onlyInA.length + onlyInB.length;

  const source_pagination_consistency_ok =
    summaryA.ok &&
    summaryB.ok &&
    summaryA.pages_failed === 0 &&
    summaryB.pages_failed === 0 &&
    (summaryA.duplicate_sailing_ids || 0) === 0 &&
    (summaryB.duplicate_sailing_ids || 0) === 0 &&
    symmetricDiff <= 20;

  return {
    fetch_a: { ...summaryA, sailing_ids: undefined },
    fetch_b: { ...summaryB, sailing_ids: undefined },
    sailing_count_delta: sailingDelta,
    symmetric_sailing_id_diff: symmetricDiff,
    only_in_fetch_a: onlyInA.slice(0, 10),
    only_in_fetch_b: onlyInB.slice(0, 10),
    group_count_explanation:
      "Official results.total counts marketed itinerary groups. Raw fetched groups may differ when RCG returns duplicate group IDs across pages or when live inventory shifts between sequential fetches. Sailings are deduplicated after expansion.",
    live_drift_note:
      symmetricDiff > 0
        ? "Sequential fetches use separate live snapshots; small symmetric sailing ID differences are treated as catalogue drift, not pagination failure."
        : null,
    source_pagination_consistency_ok
  };
}

function compareCatchupSourceSnapshots(preSnapshot, postSnapshot) {
  const preIds = new Set((preSnapshot?.sailing_ids || []).map(String));
  const postIds = new Set((postSnapshot?.sailing_ids || []).map(String));
  const added = [...postIds].filter((id) => !preIds.has(id));
  const removed = [...preIds].filter((id) => !postIds.has(id));
  return {
    pre_snapshot_id: preSnapshot?.source_snapshot_id || null,
    post_snapshot_id: postSnapshot?.source_snapshot_id || null,
    source_added_sailings: added.length,
    source_removed_sailings: removed.length,
    source_added_sample: added.slice(0, 20),
    source_removed_sample: removed.slice(0, 20),
    post_manifest_new_eligible: postSnapshot?.post_manifest_new_eligible ?? null
  };
}

module.exports = {
  MAX_ROYAL_CARIBBEAN_CATCHUP_CHUNK,
  CATCHUP_CONFIRM_TOKEN,
  CATCHUP_MASTER_MODE,
  CATCHUP_CHUNK_MODE,
  PUBLIC_ELIGIBILITY_MIN_DAYS,
  RC_LINE_ID,
  isCatchupEligible,
  selectCatchupCandidates,
  buildMasterManifest,
  splitMasterIntoChunks,
  computeChunkHash,
  validateMasterManifest,
  validateCatchupChunk,
  comparePaginationStrategies,
  analyseDuplicateGroups,
  compareCatchupSourceSnapshots,
  computeSourceSnapshotId
};
