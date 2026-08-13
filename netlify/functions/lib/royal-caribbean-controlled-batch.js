/**
 * Royal Caribbean International — controlled production batches (frozen manifest required).
 * Allowed batch sizes: 20 (batch 1) and 100 (batch 2) only — never unbounded.
 */

const crypto = require("crypto");
const {
  officialProductKey,
  officialGroupKey,
  isRoyalCaribbeanCruisetour
} = require("./royal-caribbean-discovery-adapter");
const { cruiseIdentityKey } = require("./cruise-discovery-ops");
const { daysUntilDeparture } = require("./public-discovered-cruise-inventory");
const {
  buildRoyalCaribbeanReconciliationArithmetic,
  evaluateRoyalCaribbeanDryRunHealth
} = require("./royal-caribbean-reconciliation-summary");

const MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH_1 = 20;
const MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH_2 = 100;
const MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH = MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH_1;
const ALLOWED_CONTROLLED_BATCH_SIZES = new Set([20, 100]);
const FIRST_BATCH_SAFETY_BUFFER_DAYS = 45;
const RC_LINE_ID = "1cea3c83-5fd5-41d0-b5f7-4026fee00ab5";
const RC_LINE_SLUG = "royal-caribbean-international";

const BATCH1_OFFICIAL_SAILING_IDS = [
  "AL06W286_2026-09-27",
  "LE07M843_2026-09-27",
  "SC04I858_2026-09-27",
  "SR05R020_2026-09-27",
  "OV03X039_2026-09-28",
  "GR7IP220_2026-09-27",
  "ST07E488_2026-09-27",
  "MA05W678_2026-09-28",
  "WN4BH351_2026-09-28",
  "LB07U251_2026-10-03",
  "EX07M806_2026-10-03",
  "RH07D516_2026-10-03",
  "RD04W214_2026-10-01",
  "AN18T049_2026-10-11",
  "NV11I018_2026-10-18",
  "QN08K124_2026-10-22",
  "OY14T256_2026-10-25",
  "VY07A456_2027-05-07",
  "FR07U278_2027-05-23",
  "ID04N011_2027-06-01"
];

const CONTROLLED_BATCH_PROFILES = {
  batch1: {
    batch_number: 1,
    max_batch_size: MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH_1,
    manifest_mode: "royal_caribbean_controlled_batch",
    confirm_token: "ROYAL-CARIBBEAN-FIRST-CONTROLLED-BATCH",
    max_per_ship: 2,
    max_per_port: 4
  },
  batch2: {
    batch_number: 2,
    max_batch_size: MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH_2,
    manifest_mode: "royal_caribbean_controlled_batch_2",
    confirm_token: "ROYAL-CARIBBEAN-SECOND-CONTROLLED-BATCH",
    max_per_ship: 5,
    max_per_port: 10
  }
};

function resolveBatchProfile(manifestOrKey) {
  if (typeof manifestOrKey === "string") {
    return manifestOrKey === "batch2" ? CONTROLLED_BATCH_PROFILES.batch2 : CONTROLLED_BATCH_PROFILES.batch1;
  }
  const mode = manifestOrKey?.mode;
  if (mode === CONTROLLED_BATCH_PROFILES.batch2.manifest_mode) return CONTROLLED_BATCH_PROFILES.batch2;
  if (mode === CONTROLLED_BATCH_PROFILES.batch1.manifest_mode) return CONTROLLED_BATCH_PROFILES.batch1;
  const size = Number(manifestOrKey?.max_batch_size ?? manifestOrKey?.expected_record_count ?? 0);
  if (size === 100) return CONTROLLED_BATCH_PROFILES.batch2;
  return CONTROLLED_BATCH_PROFILES.batch1;
}

function resolveManifestBatchLimit(manifest) {
  const size = Number(manifest?.max_batch_size ?? manifest?.expected_record_count ?? 0);
  if (!ALLOWED_CONTROLLED_BATCH_SIZES.has(size)) {
    const err = new Error(`Royal Caribbean manifest batch size not allowed: ${size}`);
    err.code = "royal_caribbean_batch_size_not_allowed";
    throw err;
  }
  return size;
}

function isAllowedControlledBatchMode(mode) {
  return (
    mode === CONTROLLED_BATCH_PROFILES.batch1.manifest_mode ||
    mode === CONTROLLED_BATCH_PROFILES.batch2.manifest_mode
  );
}

function isIslanRepositioningExclusion(product) {
  const code = String(product?.raw?.destination_code || "").toUpperCase();
  if (code === "ISLAN") return true;
  const reasons = product?.failure_reasons || [];
  if (reasons.some((r) => /^destination_/.test(r) || r === "confidence:review")) return true;
  if (product?.adapter_confidence === "review") return true;
  return false;
}

function isManualReviewExclusion(product) {
  const reasons = product?.failure_reasons || [];
  return reasons.some((r) => r.startsWith("confidence:") && r !== "confidence:high_confidence");
}

function isControlledBatchEligible(product, today) {
  if (!product || product.product_type !== "ocean_cruise") return false;
  if (isRoyalCaribbeanCruisetour(product.product_type)) return false;
  if (!product.complete_high_confidence) return false;
  if (product.status_class !== "open") return false;
  if (product.time_eligibility !== "eligible") return false;
  if (!product.ship_resolution?.resolved) return false;
  if (product.destination_resolution?.status !== "resolved") return false;
  if (isIslanRepositioningExclusion(product)) return false;
  if (isManualReviewExclusion(product)) return false;
  const dep = product.candidate?.departure_date || product.raw?.departure_date;
  const days = dep ? daysUntilDeparture(dep, today) : null;
  if (days == null || days < FIRST_BATCH_SAFETY_BUFFER_DAYS) return false;
  const sailingId = officialProductKey(product.raw);
  if (!sailingId) return false;
  return true;
}

const isFirstBatchEligible = isControlledBatchEligible;

function candidateSortKey(product) {
  const dep = product.candidate?.departure_date || product.raw?.departure_date || "";
  const ship = String(product.raw?.ship_code || "").toUpperCase();
  const id = officialProductKey(product.raw) || "";
  return `${dep}|${ship}|${id}`;
}

function selectControlledBatchProducts(
  products,
  {
    maxWrites,
    today,
    excludeSailingIds = new Set(),
    maxPerShip,
    maxPerPort,
    profile = null
  } = {}
) {
  const prof = profile || CONTROLLED_BATCH_PROFILES.batch1;
  const limit = Math.min(maxWrites ?? prof.max_batch_size, prof.max_batch_size);
  if (!ALLOWED_CONTROLLED_BATCH_SIZES.has(limit)) {
    throw new Error(`Batch size ${limit} is not an allowed controlled batch size`);
  }
  const perShipCap = maxPerShip ?? prof.max_per_ship;
  const perPortCap = maxPerPort ?? prof.max_per_port;
  const excluded = new Set([...(excludeSailingIds || [])].map(String));

  const eligible = (products || [])
    .filter((p) => isControlledBatchEligible(p, today))
    .filter((p) => !excluded.has(officialProductKey(p.raw)))
    .sort((a, b) => candidateSortKey(a).localeCompare(candidateSortKey(b)));

  const selected = [];
  const selectedIds = new Set();
  const shipCounts = new Map();
  const portCounts = new Map();
  const destCounts = new Map();

  function canAdd(product) {
    const ship = String(product.raw?.ship_code || "").toUpperCase();
    const port = String(product.raw?.departure_port || product.candidate?.departure_port || "").trim();
    if (ship && (shipCounts.get(ship) || 0) >= perShipCap) return false;
    if (port && (portCounts.get(port) || 0) >= perPortCap) return false;
    return true;
  }

  function add(product, reason) {
    const id = officialProductKey(product.raw);
    if (!id || selectedIds.has(id) || excluded.has(id)) return false;
    selected.push({ product, selection_reason: reason });
    selectedIds.add(id);
    const ship = String(product.raw?.ship_code || "").toUpperCase();
    const port = String(product.raw?.departure_port || product.candidate?.departure_port || "").trim();
    const dest = product.destination_resolution?.destinationKey || "unknown";
    if (ship) shipCounts.set(ship, (shipCounts.get(ship) || 0) + 1);
    if (port) portCounts.set(port, (portCounts.get(port) || 0) + 1);
    destCounts.set(dest, (destCounts.get(dest) || 0) + 1);
    return true;
  }

  function diversityScore(product) {
    const ship = String(product.raw?.ship_code || "").toUpperCase();
    const port = String(product.raw?.departure_port || product.candidate?.departure_port || "").trim();
    const dest = product.destination_resolution?.destinationKey || "unknown";
    let score = 0;
    if (!shipCounts.has(ship)) score += 8;
    if (!destCounts.has(dest)) score += 4;
    if (!portCounts.has(port)) score += 2;
    score -= (shipCounts.get(ship) || 0) * 3;
    score -= portCounts.get(port) || 0;
    return score;
  }

  const remaining = [...eligible];
  const diversityPriorityCap = Math.min(8, limit);
  while (selected.length < limit && remaining.length) {
    remaining.sort((a, b) => {
      const scoreDiff = diversityScore(b) - diversityScore(a);
      if (scoreDiff !== 0) return scoreDiff;
      return candidateSortKey(a).localeCompare(candidateSortKey(b));
    });
    let picked = false;
    for (let i = 0; i < remaining.length; i += 1) {
      if (!canAdd(remaining[i])) continue;
      add(remaining[i], selected.length < diversityPriorityCap ? "diversity_priority" : "deterministic_fill");
      remaining.splice(i, 1);
      picked = true;
      break;
    }
    if (!picked) {
      for (let i = 0; i < remaining.length; i += 1) {
        if (add(remaining[i], "constraint_relaxation")) {
          remaining.splice(i, 1);
          picked = true;
          break;
        }
      }
    }
    if (!picked) break;
  }

  return {
    selected: selected.slice(0, limit),
    eligible_pool_size: eligible.length,
    excluded_existing_count: excluded.size,
    composition: {
      unique_ships: [...shipCounts.keys()],
      unique_ship_count: shipCounts.size,
      unique_destinations: [...destCounts.keys()],
      unique_destination_count: destCounts.size,
      unique_embarkation_ports: [...portCounts.keys()],
      unique_embarkation_port_count: portCounts.size,
      ship_distribution: Object.fromEntries(shipCounts),
      port_distribution: Object.fromEntries(portCounts),
      destination_distribution: Object.fromEntries(destCounts)
    }
  };
}

function buildFrozenManifestEntry(product, cruiseLine, destinations) {
  const {
    buildRoyalCaribbeanUpsertCandidate,
    royalCaribbeanExternalKey
  } = require("./royal-caribbean-discovery-writes");
  const raw = product.raw || {};
  const productKey = officialProductKey(raw);
  const groupKey = officialGroupKey(raw);
  const dest = (destinations || []).find((d) => d.slug === product.destination_resolution?.destinationKey);
  const candidate = buildRoyalCaribbeanUpsertCandidate(product, cruiseLine);
  const external_key = royalCaribbeanExternalKey(cruiseLine.id, productKey);
  const identity_key = cruiseIdentityKey({
    cruiseLineId: cruiseLine.id,
    shipId: candidate?.ship_id,
    departureDate: candidate?.departure_date,
    officialUrl: candidate?.official_url,
    nights: candidate?.nights,
    returnDate: candidate?.return_date,
    officialSailingId: productKey
  });

  return {
    official_sailing_id: productKey,
    official_group_id: groupKey,
    package_code: raw.package_code || raw.itinerary_code || null,
    cruise_line_id: cruiseLine.id,
    source_ship_code: raw.ship_code || null,
    resolved_ship_db_id: product.ship_resolution?.ship?.id || candidate?.ship_id || null,
    ship_name: product.ship_resolution?.ship?.name || raw.ship_name || null,
    departure_date: candidate?.departure_date || raw.departure_date || null,
    return_date: candidate?.return_date || null,
    nights: candidate?.nights || raw.nights || null,
    embarkation_source_value: raw.departure_port || null,
    embarkation_source_code: raw.departure_port_code || null,
    resolved_embarkation_port_id:
      product.departure_port_resolution?.canonicalPortId ||
      product.candidate?.departure_port_meta?.canonicalPortId ||
      null,
    resolved_embarkation_port_name: candidate?.departure_port || null,
    destination_source_code: raw.destination_code || null,
    destination_source_name: raw.destination_name || null,
    resolved_destination_id: dest?.id || candidate?.destination_id || null,
    resolved_destination_slug: product.destination_resolution?.destinationKey || dest?.slug || null,
    itinerary: candidate?.itinerary || raw.itinerary_ports || null,
    source_status: raw.sailing_status || product.sailing_status || null,
    booking_url: candidate?.official_url || raw.official_url || null,
    external_key,
    identity_key,
    proposed_action: "insert_active",
    candidate
  };
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function computeManifestHash(manifest) {
  const entries = (manifest?.entries || [])
    .map((e) => ({
      official_sailing_id: e.official_sailing_id,
      identity_key: e.identity_key,
      external_key: e.external_key,
      departure_date: e.departure_date,
      resolved_ship_db_id: e.resolved_ship_db_id,
      resolved_destination_id: e.resolved_destination_id
    }))
    .sort((a, b) => String(a.official_sailing_id).localeCompare(String(b.official_sailing_id)));
  return crypto.createHash("sha256").update(stableStringify(entries)).digest("hex");
}

function computeSourceSnapshotId(simulation) {
  const ids = (simulation?.products || [])
    .map((p) => officialProductKey(p.raw))
    .filter(Boolean)
    .sort();
  const basis = [
    simulation?.official_reported_total || 0,
    ids.length,
    simulation?.itinerary_groups_fetched || 0,
    ids.slice(0, 5).join(","),
    ids.slice(-5).join(",")
  ].join("|");
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

function compareSourceSnapshots(preSnapshot, postSnapshot) {
  const preIds = new Set((preSnapshot?.sailing_ids || []).map(String));
  const postIds = new Set((postSnapshot?.sailing_ids || []).map(String));
  const added = [...postIds].filter((id) => !preIds.has(id));
  const removed = [...preIds].filter((id) => !postIds.has(id));
  return {
    pre_snapshot_id: preSnapshot?.source_snapshot_id || null,
    post_snapshot_id: postSnapshot?.source_snapshot_id || null,
    pre_unique_sailings: preIds.size,
    post_unique_sailings: postIds.size,
    source_added_sailings: added.length,
    source_removed_sailings: removed.length,
    source_added_sample: added.slice(0, 10),
    source_removed_sample: removed.slice(0, 10),
    pre_proposed_inserts: preSnapshot?.proposed_inserts ?? null,
    post_proposed_inserts: postSnapshot?.proposed_inserts ?? null,
    pre_recognised_existing: preSnapshot?.recognised_existing ?? null,
    post_recognised_existing: postSnapshot?.recognised_existing ?? null,
    database_inserts_between_snapshots: postSnapshot?.database_inserts_between_snapshots ?? null,
    note:
      "Outstanding eligible insert counts can change due to live source movement as well as database inserts. Do not assume previous_outstanding - inserted = new_outstanding."
  };
}

function buildFrozenManifest({
  selected,
  cruiseLine,
  destinations,
  batchId,
  sourceSnapshotId,
  sourceFetchedAt,
  today,
  profile = CONTROLLED_BATCH_PROFILES.batch1,
  exclude_overlap_ids = []
}) {
  const entries = selected.map(({ product, selection_reason }) => ({
    ...buildFrozenManifestEntry(product, cruiseLine, destinations),
    selection_reason
  }));
  const manifest = {
    batch_id: batchId,
    batch_number: profile.batch_number,
    generated_at: new Date().toISOString(),
    mode: profile.manifest_mode,
    cruise_line_id: cruiseLine.id,
    cruise_line_slug: RC_LINE_SLUG,
    expected_record_count: profile.max_batch_size,
    max_batch_size: profile.max_batch_size,
    confirm_token: profile.confirm_token,
    first_batch_safety_buffer_days: FIRST_BATCH_SAFETY_BUFFER_DAYS,
    perth_today: today,
    source_snapshot_id: sourceSnapshotId,
    source_fetched_at: sourceFetchedAt,
    exclude_overlap_ids: [...exclude_overlap_ids],
    writes_performed: false,
    actual_writes: 0,
    entries
  };
  manifest.manifest_hash = computeManifestHash(manifest);
  return manifest;
}

function validateBatchOverlap(manifest, priorSailingIds = []) {
  const prior = new Set(priorSailingIds.map(String));
  const overlap = (manifest.entries || [])
    .map((e) => e.official_sailing_id)
    .filter((id) => prior.has(String(id)));
  return {
    passed: overlap.length === 0,
    failures: overlap.length ? [`overlap_with_prior_batch:${overlap.join(",")}`] : [],
    overlap_count: overlap.length,
    overlap_ids: overlap
  };
}

function validateFrozenManifest(manifest, { expectedHash = null, today = null, priorSailingIds = [] } = {}) {
  const failures = [];
  const entries = manifest?.entries || [];
  const perthToday = today || manifest?.perth_today;
  let expectedCount;
  try {
    expectedCount = resolveManifestBatchLimit(manifest);
  } catch (error) {
    failures.push(error.message);
    expectedCount = 0;
  }

  if (!isAllowedControlledBatchMode(manifest?.mode)) {
    failures.push(`invalid_manifest_mode:${manifest?.mode}`);
  }
  if (entries.length !== expectedCount) {
    failures.push(`manifest_count_mismatch:${entries.length}_expected_${expectedCount}`);
  }
  if (entries.length > expectedCount) {
    failures.push(`manifest_exceeds_hard_limit:${entries.length}`);
  }

  const sailingIds = entries.map((e) => e.official_sailing_id).filter(Boolean);
  if (new Set(sailingIds).size !== sailingIds.length) failures.push("duplicate_official_sailing_ids");
  if (new Set(sailingIds).size !== entries.length) failures.push("missing_official_sailing_id");

  const identityKeys = entries.map((e) => e.identity_key).filter(Boolean);
  if (new Set(identityKeys).size !== identityKeys.length) failures.push("duplicate_identity_keys");

  if (entries.some((e) => e.proposed_action !== "insert_active")) failures.push("non_insert_action_present");
  if (entries.some((e) => !e.resolved_ship_db_id)) failures.push("unresolved_ships");
  if (entries.some((e) => !e.resolved_embarkation_port_name)) failures.push("unresolved_embarkation_ports");
  if (entries.some((e) => !e.resolved_destination_id)) failures.push("unresolved_destinations");
  if (entries.some((e) => String(e.destination_source_code || "").toUpperCase() === "ISLAN")) {
    failures.push("islan_repositioning_present");
  }

  for (const entry of entries) {
    const days = entry.departure_date ? daysUntilDeparture(entry.departure_date, perthToday) : null;
    if (days != null && days <= 21) failures.push(`within_21_day_cutoff:${entry.official_sailing_id}`);
    if (days != null && days < FIRST_BATCH_SAFETY_BUFFER_DAYS) {
      failures.push(`departure_inside_45_day_buffer:${entry.official_sailing_id}`);
    }
  }

  const overlapSource = [
    ...(priorSailingIds || []),
    ...(manifest.exclude_overlap_ids || [])
  ];
  const overlap = validateBatchOverlap(manifest, overlapSource);
  if (!overlap.passed) failures.push(...overlap.failures);

  if (expectedHash && manifest.manifest_hash !== expectedHash) failures.push("manifest_hash_mismatch");
  if (expectedHash && computeManifestHash(manifest) !== expectedHash) failures.push("manifest_hash_recompute_mismatch");

  const gates = {
    manifest_count: entries.length === expectedCount,
    unique_official_sailing_ids: new Set(sailingIds).size === expectedCount,
    unique_identity_keys: new Set(identityKeys).size === expectedCount,
    existing_official_sailing_ids_0: true,
    overlap_with_prior_batch_0: overlap.passed,
    unresolved_ships_0: !entries.some((e) => !e.resolved_ship_db_id),
    unresolved_embarkation_ports_0: !entries.some((e) => !e.resolved_embarkation_ports_name),
    unresolved_destinations_0: !entries.some((e) => !e.resolved_destination_id),
    within_21_day_cutoff_0: !entries.some((e) => {
      const days = e.departure_date ? daysUntilDeparture(e.departure_date, perthToday) : null;
      return days != null && days <= 21;
    }),
    departure_inside_45_day_buffer_0: !entries.some((e) => {
      const days = e.departure_date ? daysUntilDeparture(e.departure_date, perthToday) : null;
      return days != null && days < FIRST_BATCH_SAFETY_BUFFER_DAYS;
    }),
    manual_review_records_0: !entries.some((e) => String(e.destination_source_code || "").toUpperCase() === "ISLAN"),
    cruisetours_0: true,
    manifest_hash_valid: !expectedHash || manifest.manifest_hash === expectedHash
  };
  gates.unresolved_embarkation_ports_0 = !entries.some((e) => !e.resolved_embarkation_port_name);

  return { passed: failures.length === 0, failures, gates, expected_count: expectedCount };
}

async function validateManifestAgainstProduction(manifest, indexes) {
  const { isLegacyHtmlDiscoveryRow } = require("./royal-caribbean-discovery-writes");
  const failures = [];
  let existingCount = 0;
  for (const entry of manifest.entries || []) {
    const existing =
      indexes.byProductKey.get(entry.official_sailing_id) ||
      indexes.byIdentity.get(entry.identity_key) ||
      indexes.byExternal.get(entry.external_key);
    if (existing && !isLegacyHtmlDiscoveryRow(existing)) {
      existingCount += 1;
      failures.push(`existing_official_sailing_id:${entry.official_sailing_id}`);
    }
  }
  return { passed: failures.length === 0, failures, existing_official_sailing_ids: existingCount };
}

async function concurrencyPreflightManifestIds(manifest, indexes) {
  return validateManifestAgainstProduction(manifest, indexes);
}

function evaluatePreWriteDryRunGate({ simulation, manifest, arithmetic, health }) {
  const failures = [];
  if (!simulation?.ok) failures.push("source_fetch_failed");
  if ((simulation?.pagination?.pages_failed || 0) > 0) failures.push("failed_pages");
  if (simulation?.pagination?.incomplete_pagination) failures.push("incomplete_pagination");
  if ((simulation?.ingestion_audit?.duplicate_sailing_ids || 0) > 0) failures.push("duplicate_sailing_ids");
  if (!health?.passed) failures.push(...(health?.failures || ["dry_run_health_failed"]));
  if (!arithmetic?.reconciliation_arithmetic_ok) failures.push("reconciliation_arithmetic_failed");

  const shipAudit = simulation?.ship_audit;
  if (shipAudit?.unresolved > 0) failures.push(`unresolved_ships:${shipAudit.unresolved}`);

  const embarkUnresolved = (simulation?.port_audit?.unresolved_conventional || []).filter(
    (r) => r.role === "embarkation"
  );
  if (embarkUnresolved.length) failures.push(`unresolved_embarkation:${embarkUnresolved.map((r) => r.name).join(",")}`);

  const manifestValidation = validateFrozenManifest(manifest, {
    priorSailingIds: manifest?.exclude_overlap_ids || []
  });
  if (!manifestValidation.passed) failures.push(...manifestValidation.failures);

  return { passed: failures.length === 0, failures, manifest_gates: manifestValidation.gates };
}

module.exports = {
  MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH,
  MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH_1,
  MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH_2,
  ALLOWED_CONTROLLED_BATCH_SIZES,
  FIRST_BATCH_SAFETY_BUFFER_DAYS,
  RC_LINE_ID,
  RC_LINE_SLUG,
  BATCH1_OFFICIAL_SAILING_IDS,
  CONTROLLED_BATCH_PROFILES,
  resolveBatchProfile,
  resolveManifestBatchLimit,
  isAllowedControlledBatchMode,
  isIslanRepositioningExclusion,
  isFirstBatchEligible,
  isControlledBatchEligible,
  selectControlledBatchProducts,
  buildFrozenManifestEntry,
  buildFrozenManifest,
  computeManifestHash,
  computeSourceSnapshotId,
  compareSourceSnapshots,
  validateBatchOverlap,
  validateFrozenManifest,
  validateManifestAgainstProduction,
  concurrencyPreflightManifestIds,
  evaluatePreWriteDryRunGate,
  buildRoyalCaribbeanReconciliationArithmetic,
  evaluateRoyalCaribbeanDryRunHealth
};
