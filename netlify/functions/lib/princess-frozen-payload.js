/**
 * Princess frozen remediation — canonical write payload hashing and comparison.
 * All freeze/apply paths derive payloads from buildPrincessUpsertCandidate().
 */

const crypto = require("crypto");
const { buildPrincessUpsertCandidate } = require("./princess-discovery-writes");

const P3_BATCH_MAX_WRITES = 30;

/** Fields excluded from hash — volatile or non-material for upsert equality. */
const HASH_EXCLUDE_KEYS = new Set([
  "last_seen_at",
  "last_verified_at",
  "last_changed_at",
  "created_at",
  "updated_at",
  "princess_batch_write"
]);

function normaliseString(value) {
  if (value == null) return null;
  return String(value).trim();
}

function normaliseDate(value) {
  if (value == null) return null;
  return String(value).slice(0, 10);
}

function extractRawProvenance(rawExtract = {}) {
  return {
    princess_sailing_id: rawExtract.princess_sailing_id ?? null,
    princess_group_id: rawExtract.princess_group_id ?? null,
    princess_product_type: rawExtract.princess_product_type ?? null,
    princess_adapter_id: rawExtract.princess_adapter_id ?? null,
    princess_adapter_version: rawExtract.princess_adapter_version ?? null,
    destination_key: rawExtract.destination_key ?? null,
    ship_match_method: rawExtract.ship_match_method ?? null
  };
}

/**
 * Canonical material write fields for hash/compare — mirrors upsertCandidateRecord input.
 */
function canonicalPrincessWritePayloadForHash(candidate = {}) {
  const raw = candidate.raw_extract || {};
  const provenance = extractRawProvenance(raw);
  const payload = {
    cruise_line_id: candidate.cruise_line_id ?? null,
    ship_id: candidate.ship_id ?? null,
    destination_id: candidate.destination_id ?? null,
    departure_date: normaliseDate(candidate.departure_date),
    return_date: normaliseDate(candidate.return_date),
    nights: candidate.nights ?? null,
    departure_port: normaliseString(candidate.departure_port),
    itinerary: normaliseString(candidate.itinerary),
    official_url: normaliseString(candidate.official_url),
    source_url: normaliseString(candidate.source_url || candidate.official_url),
    status: candidate.status ?? "active",
    match_confidence: candidate.match_confidence ?? "high",
    official_sailing_id: normaliseString(candidate.official_sailing_id),
    external_key: normaliseString(candidate.external_key),
    identity_key: normaliseString(candidate.identity_key),
    brochure_fare: candidate.brochure_fare ?? null,
    currency: candidate.currency ?? null,
    brochure_fare_display: candidate.brochure_fare_display ?? null,
    raw_extract: provenance
  };
  return payload;
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function hashPrincessFrozenCandidate(candidate) {
  const canonical = canonicalPrincessWritePayloadForHash(candidate);
  return crypto.createHash("sha256").update(stableStringify(canonical)).digest("hex");
}

function hashPrincessFrozenBatch(candidates) {
  const hashes = (candidates || []).map((c) => {
    const payload = c.canonical_write_payload || c.write_payload || c;
    return hashPrincessFrozenCandidate(payload);
  });
  return crypto.createHash("sha256").update(JSON.stringify(hashes.sort())).digest("hex");
}

function comparePrincessLiveCandidateToFreeze({ liveCandidate, frozenCandidate } = {}) {
  const liveCanonical = canonicalPrincessWritePayloadForHash(liveCandidate);
  const frozenCanonical = canonicalPrincessWritePayloadForHash(
    frozenCandidate?.canonical_write_payload || frozenCandidate?.write_payload || frozenCandidate
  );
  const liveHash = hashPrincessFrozenCandidate(liveCandidate);
  const frozenHash = hashPrincessFrozenCandidate(
    frozenCandidate?.canonical_write_payload || frozenCandidate?.write_payload || frozenCandidate
  );

  const fieldDifferences = [];
  const allKeys = new Set([...Object.keys(liveCanonical), ...Object.keys(frozenCanonical)]);
  for (const key of [...allKeys].sort()) {
    const liveVal = stableStringify(liveCanonical[key]);
    const frozenVal = stableStringify(frozenCanonical[key]);
    if (liveVal !== frozenVal) {
      fieldDifferences.push({ field: key, live: liveCanonical[key], frozen: frozenCanonical[key] });
    }
  }

  return {
    ok: fieldDifferences.length === 0 && liveHash === frozenHash,
    field_differences: fieldDifferences,
    frozen_hash: frozenHash,
    live_hash: liveHash
  };
}

function buildFrozenCandidateFromProductRow(row, cruiseLine, meta = {}) {
  const upsert = buildPrincessUpsertCandidate(row, cruiseLine);
  if (!upsert) return null;
  if (!upsert.external_key || !upsert.identity_key || !upsert.official_sailing_id) {
    return null;
  }

  const canonical_write_payload = canonicalPrincessWritePayloadForHash(upsert);
  const candidate_hash = hashPrincessFrozenCandidate(upsert);

  return {
    official_sailing_id: upsert.official_sailing_id,
    canonical_write_payload,
    write_payload: upsert,
    candidate_hash,
    resolver_remediated: meta.resolver_remediated === true,
    old_rule_eligible_current_production_missing: meta.old_rule_eligible_current_production_missing === true,
    historical_2026_08_10_source_present: meta.historical_2026_08_10_source_present ?? "unknown",
    source_raw: {
      departure_port: row.candidate?.departure_port || null,
      ship_code: row.raw?.shipCode || row.raw?.ship_code || null,
      itinerary_id: row.raw?.itineraryId || row.raw?.itinerary_id || null
    },
    resolver_evidence: {
      destination_method: row.destination_resolution?.method || null,
      departure_port_method: row.departure_port_resolution?.method || null,
      destination_key: row.destination_resolution?.destinationKey || null
    }
  };
}

function validateFrozenCandidateKeys(candidate) {
  const payload = candidate?.write_payload || candidate?.canonical_write_payload || candidate;
  const failures = [];
  if (!payload?.official_sailing_id) failures.push("missing_official_sailing_id");
  if (!payload?.external_key) failures.push("missing_external_key");
  if (!payload?.identity_key) failures.push("missing_identity_key");
  return { ok: failures.length === 0, failures };
}

function validateFrozenBatchCandidates(candidates) {
  const issues = [];
  for (const c of candidates || []) {
    const v = validateFrozenCandidateKeys(c);
    if (!v.ok) {
      issues.push({ official_sailing_id: c.official_sailing_id, failures: v.failures });
    }
  }
  return { ok: issues.length === 0, issues, coverage_pct: candidates?.length ? ((candidates.length - issues.length) / candidates.length) * 100 : 0 };
}

function assertBatchSizeWithinCap(size, max = P3_BATCH_MAX_WRITES) {
  if (size < 1 || size > max) {
    const err = new Error(`batch size ${size} exceeds P3 cap ${max}`);
    err.code = "p3_batch_size_exceeds_cap";
    throw err;
  }
}

module.exports = {
  P3_BATCH_MAX_WRITES,
  canonicalPrincessWritePayloadForHash,
  hashPrincessFrozenCandidate,
  hashPrincessFrozenBatch,
  comparePrincessLiveCandidateToFreeze,
  buildFrozenCandidateFromProductRow,
  validateFrozenCandidateKeys,
  validateFrozenBatchCandidates,
  assertBatchSizeWithinCap,
  stableStringify
};
