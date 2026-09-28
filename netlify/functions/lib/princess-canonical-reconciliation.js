/**
 * Canonical Princess active-production partition.
 *
 * Every ACTIVE discovered_cruise UUID is assigned to exactly one bucket.
 * Counts are derived from UUID sets — never from overlapping sailing-id arrays.
 */

const {
  publicBookingMinimumDepartureDate
} = require("./public-discovered-cruise-inventory");

const PRINCESS_ACTIVE_BUCKETS = Object.freeze([
  "RECOGNISED_ELIGIBLE",
  "DETERMINISTIC_IDENTITY_REMAP",
  "SOURCE_ABSENT_RETAINED",
  "DAILY_EXPIRY_MANAGED",
  "LEGACY_EXPLAINED",
  "REVIEW_REQUIRED",
  "UNEXPLAINED"
]);

function normaliseId(value) {
  return value == null ? "" : String(value).trim();
}

function uniqueUuids(ids = []) {
  const out = [];
  const seen = new Set();
  for (const id of ids || []) {
    const uuid = normaliseId(id);
    if (!uuid || seen.has(uuid)) continue;
    seen.add(uuid);
    out.push(uuid);
  }
  return out;
}

function officialIdOf(row = {}) {
  return (
    normaliseId(row.official_sailing_id) ||
    normaliseId(row.official_princess_sailing_id) ||
    normaliseId(row.raw_extract?.princess_sailing_id)
  );
}

function dedupeSourceAbsentByUuid(rows = []) {
  const seen = new Set();
  const unique = [];
  const duplicateEntries = [];
  for (const row of rows || []) {
    const uuid = normaliseId(row.discovered_cruise_id || row.id);
    if (!uuid) {
      duplicateEntries.push({ reason: "missing_uuid", official_sailing_id: officialIdOf(row) });
      continue;
    }
    if (seen.has(uuid)) {
      duplicateEntries.push({
        discovered_cruise_id: uuid,
        official_sailing_id: officialIdOf(row),
        reason: "duplicate_source_absence_path"
      });
      continue;
    }
    seen.add(uuid);
    unique.push({
      ...row,
      discovered_cruise_id: uuid,
      official_sailing_id: officialIdOf(row) || row.official_sailing_id || null
    });
  }
  return { unique, duplicate_entries: duplicateEntries };
}

function emptyBucketLists() {
  return Object.fromEntries(PRINCESS_ACTIVE_BUCKETS.map((name) => [name, []]));
}

function assignOnce(assigned, buckets, uuid, bucket, detail) {
  if (!uuid || assigned.has(uuid)) return false;
  assigned.add(uuid);
  buckets[bucket].push({ discovered_cruise_id: uuid, ...detail });
  return true;
}

/**
 * Partition every active production UUID into exactly one canonical bucket.
 *
 * Assignment priority (first match wins):
 * 1. DAILY_EXPIRY_MANAGED — departure before public-booking minimum
 * 2. DETERMINISTIC_IDENTITY_REMAP
 * 3. REVIEW_REQUIRED — ambiguous remap, true identity change, or identity-critical update
 * 4. RECOGNISED_ELIGIBLE — official ID present in eligible source, or safe/recognised update
 * 5. LEGACY_EXPLAINED — explicit allow-list
 * 6. SOURCE_ABSENT_RETAINED — official ID absent from eligible source
 * 7. UNEXPLAINED
 */
function partitionPrincessActiveProduction({
  activeRows = [],
  eligibleOfficialIds = [],
  recognisedUuids = [],
  deterministicRemapUuids = [],
  reviewUuids = [],
  dailyExpiryUuids = [],
  legacyExplainedUuids = [],
  sourceAbsentUuids = [],
  today = null
} = {}) {
  const eligible = new Set((eligibleOfficialIds || []).map(normaliseId).filter(Boolean));
  const recognised = new Set(uniqueUuids(recognisedUuids));
  const remaps = new Set(uniqueUuids(deterministicRemapUuids));
  const reviews = new Set(uniqueUuids(reviewUuids));
  const dailyExpiry = new Set(uniqueUuids(dailyExpiryUuids));
  const legacy = new Set(uniqueUuids(legacyExplainedUuids));
  const sourceAbsent = new Set(uniqueUuids(sourceAbsentUuids));
  const minDeparture = today ? publicBookingMinimumDepartureDate(today) : null;

  const buckets = emptyBucketLists();
  const assigned = new Set();
  const seenActive = new Set();

  for (const row of activeRows || []) {
    const uuid = normaliseId(row.id || row.discovered_cruise_id);
    if (!uuid || seenActive.has(uuid)) continue;
    seenActive.add(uuid);
    const official = officialIdOf(row);
    const departure = String(row.departure_date || "").slice(0, 10);
    const detail = {
      official_sailing_id: official || null,
      ship_id: row.ship_id || null,
      departure_date: departure || null,
      return_date: row.return_date || null,
      nights: row.nights ?? null,
      departure_port: row.departure_port || null,
      destination_id: row.destination_id || null,
      external_key: row.external_key || null,
      identity_key: row.identity_key || null,
      status: row.status || null
    };

    const isDailyExpiry =
      dailyExpiry.has(uuid) || (minDeparture && departure && departure < minDeparture);
    if (isDailyExpiry) {
      assignOnce(assigned, buckets, uuid, "DAILY_EXPIRY_MANAGED", {
        ...detail,
        reason: "public_booking_cutoff"
      });
      continue;
    }
    if (remaps.has(uuid)) {
      assignOnce(assigned, buckets, uuid, "DETERMINISTIC_IDENTITY_REMAP", {
        ...detail,
        reason: "deterministic_official_id_remap"
      });
      continue;
    }
    if (reviews.has(uuid)) {
      assignOnce(assigned, buckets, uuid, "REVIEW_REQUIRED", {
        ...detail,
        reason: "review_lane"
      });
      continue;
    }
    if (recognised.has(uuid) || (official && eligible.has(official))) {
      assignOnce(assigned, buckets, uuid, "RECOGNISED_ELIGIBLE", {
        ...detail,
        reason: official && eligible.has(official) ? "official_id_in_eligible_source" : "recognised_match"
      });
      continue;
    }
    if (legacy.has(uuid)) {
      assignOnce(assigned, buckets, uuid, "LEGACY_EXPLAINED", {
        ...detail,
        reason: "legacy_explained"
      });
      continue;
    }
    if (sourceAbsent.has(uuid) || (official && official && !eligible.has(official))) {
      assignOnce(assigned, buckets, uuid, "SOURCE_ABSENT_RETAINED", {
        ...detail,
        reason: "source_absent_retained_active"
      });
      continue;
    }
    assignOnce(assigned, buckets, uuid, "UNEXPLAINED", {
      ...detail,
      reason: "no_canonical_bucket"
    });
  }

  const counts = Object.fromEntries(
    PRINCESS_ACTIVE_BUCKETS.map((name) => [name, buckets[name].length])
  );
  const uuidLists = Object.fromEntries(
    PRINCESS_ACTIVE_BUCKETS.map((name) => [
      name,
      buckets[name].map((row) => row.discovered_cruise_id)
    ])
  );
  const activeTotal = seenActive.size;
  const assignedTotal = assigned.size;
  const sumBuckets = PRINCESS_ACTIVE_BUCKETS.reduce((acc, name) => acc + counts[name], 0);

  return {
    buckets,
    counts,
    uuid_lists: uuidLists,
    active_production_total: activeTotal,
    assigned_total: assignedTotal,
    sum_bucket_counts: sumBuckets,
    accounting_exact: sumBuckets === activeTotal && assignedTotal === activeTotal,
    unexplained_count: counts.UNEXPLAINED,
    unexplained_ok: counts.UNEXPLAINED === 0,
    mutually_exclusive: assignedTotal === activeTotal,
    collectively_exhaustive: sumBuckets === activeTotal && counts.UNEXPLAINED === counts.UNEXPLAINED
  };
}

function assertPrincessCanonicalAccounting(partition) {
  const failures = [];
  if (!partition) {
    return { ok: false, failures: ["canonical_partition_missing"] };
  }
  if (partition.accounting_exact !== true) {
    failures.push("canonical_bucket_sum_mismatch");
  }
  if (partition.unexplained_ok !== true) {
    failures.push("unexplained_active_rows");
  }
  return {
    ok: failures.length === 0,
    failures,
    unexplained_count: partition.unexplained_count,
    unexplained_uuids: partition.uuid_lists?.UNEXPLAINED || []
  };
}

module.exports = {
  PRINCESS_ACTIVE_BUCKETS,
  uniqueUuids,
  officialIdOf,
  dedupeSourceAbsentByUuid,
  partitionPrincessActiveProduction,
  assertPrincessCanonicalAccounting
};
