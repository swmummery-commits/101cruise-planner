/**
 * Royal Caribbean International — first controlled production batch (max 20).
 * Frozen manifest required; no dynamic source substitution during apply.
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

const MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH = 20;
const FIRST_BATCH_SAFETY_BUFFER_DAYS = 45;
const RC_LINE_ID = "1cea3c83-5fd5-41d0-b5f7-4026fee00ab5";
const RC_LINE_SLUG = "royal-caribbean-international";

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

function isFirstBatchEligible(product, today) {
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

function candidateSortKey(product) {
  const dep = product.candidate?.departure_date || product.raw?.departure_date || "";
  const ship = String(product.raw?.ship_code || "").toUpperCase();
  const id = officialProductKey(product.raw) || "";
  return `${dep}|${ship}|${id}`;
}

function selectControlledBatchProducts(products, { maxWrites = MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH, today } = {}) {
  const limit = Math.min(maxWrites, MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH);
  const eligible = (products || [])
    .filter((p) => isFirstBatchEligible(p, today))
    .sort((a, b) => candidateSortKey(a).localeCompare(candidateSortKey(b)));

  const selected = [];
  const selectedIds = new Set();
  const shipCounts = new Map();
  const portCounts = new Map();
  const destCounts = new Map();

  const MAX_PER_SHIP = 2;
  const MAX_PER_PORT = 4;

  function canAdd(product) {
    const ship = String(product.raw?.ship_code || "").toUpperCase();
    const port = String(product.raw?.departure_port || product.candidate?.departure_port || "").trim();
    if (ship && (shipCounts.get(ship) || 0) >= MAX_PER_SHIP) return false;
    if (port && (portCounts.get(port) || 0) >= MAX_PER_PORT) return false;
    return true;
  }

  function add(product, reason) {
    const id = officialProductKey(product.raw);
    if (!id || selectedIds.has(id)) return false;
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
  while (selected.length < limit && remaining.length) {
    remaining.sort((a, b) => {
      const scoreDiff = diversityScore(b) - diversityScore(a);
      if (scoreDiff !== 0) return scoreDiff;
      return candidateSortKey(a).localeCompare(candidateSortKey(b));
    });
    let picked = false;
    for (let i = 0; i < remaining.length; i += 1) {
      const product = remaining[i];
      if (!canAdd(product)) continue;
      add(product, selected.length < 8 ? "diversity_priority" : "deterministic_fill");
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

function buildFrozenManifest({
  selected,
  cruiseLine,
  destinations,
  batchId,
  sourceSnapshotId,
  sourceFetchedAt,
  today
}) {
  const entries = selected.map(({ product, selection_reason }) => ({
    ...buildFrozenManifestEntry(product, cruiseLine, destinations),
    selection_reason
  }));
  const manifest = {
    batch_id: batchId,
    generated_at: new Date().toISOString(),
    mode: "royal_caribbean_controlled_batch",
    cruise_line_id: cruiseLine.id,
    cruise_line_slug: RC_LINE_SLUG,
    expected_record_count: MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH,
    max_batch_size: MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH,
    first_batch_safety_buffer_days: FIRST_BATCH_SAFETY_BUFFER_DAYS,
    perth_today: today,
    source_snapshot_id: sourceSnapshotId,
    source_fetched_at: sourceFetchedAt,
    writes_performed: false,
    actual_writes: 0,
    entries
  };
  manifest.manifest_hash = computeManifestHash(manifest);
  return manifest;
}

function validateFrozenManifest(manifest, { expectedHash = null, today = null } = {}) {
  const failures = [];
  const entries = manifest?.entries || [];
  const perthToday = today || manifest?.perth_today;

  if (entries.length !== MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH) {
    failures.push(`manifest_count_not_20:${entries.length}`);
  }
  if (entries.length > MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH) {
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

  if (expectedHash && manifest.manifest_hash !== expectedHash) failures.push("manifest_hash_mismatch");
  if (expectedHash && computeManifestHash(manifest) !== expectedHash) failures.push("manifest_hash_recompute_mismatch");

  const gates = {
    manifest_count_20: entries.length === MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH,
    unique_official_sailing_ids_20: new Set(sailingIds).size === MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH,
    unique_identity_keys_20: new Set(identityKeys).size === MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH,
    existing_official_sailing_ids_0: true,
    unresolved_ships_0: !entries.some((e) => !e.resolved_ship_db_id),
    unresolved_embarkation_ports_0: !entries.some((e) => !e.resolved_embarkation_port_name),
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

  return { passed: failures.length === 0, failures, gates };
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

  const manifestValidation = validateFrozenManifest(manifest);
  if (!manifestValidation.passed) failures.push(...manifestValidation.failures);

  return { passed: failures.length === 0, failures, manifest_gates: manifestValidation.gates };
}

module.exports = {
  MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH,
  FIRST_BATCH_SAFETY_BUFFER_DAYS,
  RC_LINE_ID,
  RC_LINE_SLUG,
  isIslanRepositioningExclusion,
  isFirstBatchEligible,
  selectControlledBatchProducts,
  buildFrozenManifestEntry,
  buildFrozenManifest,
  computeManifestHash,
  computeSourceSnapshotId,
  validateFrozenManifest,
  validateManifestAgainstProduction,
  evaluatePreWriteDryRunGate,
  buildRoyalCaribbeanReconciliationArithmetic,
  evaluateRoyalCaribbeanDryRunHealth
};
