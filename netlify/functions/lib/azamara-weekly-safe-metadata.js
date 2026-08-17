/**
 * Azamara weekly safe-metadata — stable projection, comparison, and merge.
 * Weekly maintenance must not rewrite production because of volatile raw_extract fields.
 */

const VOLATILE_RAW_EXTRACT_KEYS = new Set([
  "azamara_weekly_run_id",
  "azamara_weekly_action",
  "azamara_weekly_safe_update",
  "azamara_last_verified_at",
  "azamara_catchup_batch",
  "excerpt_chars",
  "fetched_at",
  "generated_at",
  "last_fetched_at",
  "request_id",
  "maintenance_run_id",
  "elapsed_ms",
  "source_fetch_status",
  "azamara_source_status"
]);

function normaliseComparableText(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/&amp;/g, "&");
}

function stableDeparturePortMeta(meta) {
  if (!meta || typeof meta !== "object") return null;
  return {
    rawValue: meta.rawValue ?? null,
    canonicalPortId: meta.canonicalPortId ?? null,
    canonicalPortName: meta.canonicalPortName ?? null,
    confidence: meta.confidence ?? null,
    status: meta.status ?? null,
    sourceField: meta.sourceField ?? null
  };
}

function stableDiscovery11d2(value) {
  if (!value || typeof value !== "object") return null;
  return {
    adapter: value.adapter ?? null,
    adapter_version: value.adapter_version ?? null,
    source_method: value.source_method ?? null,
    positive_signals: [...(value.positive_signals || [])].map(String).sort()
  };
}

function projectAzamaraWeeklySafeMetadata(rawExtract) {
  const raw = rawExtract && typeof rawExtract === "object" ? rawExtract : {};
  return {
    title: normaliseComparableText(raw.title) || null,
    description: normaliseComparableText(raw.description) || null,
    excerpt: normaliseComparableText(raw.excerpt) || null,
    canonical_url: normaliseComparableText(raw.canonical_url) || null,
    destination_name: normaliseComparableText(raw.destination_name) || null,
    ship_name_guesses: [...(raw.ship_name_guesses || [])].map((v) => String(v).trim()).filter(Boolean).sort(),
    azamara_package_code: raw.azamara_package_code ?? null,
    azamara_product_type: raw.azamara_product_type ?? null,
    azamara_gtm_duration: raw.azamara_gtm_duration ?? null,
    structured_source: raw.structured_source ?? null,
    departure_port_meta: stableDeparturePortMeta(raw.departure_port_meta),
    discovery_11d2: stableDiscovery11d2(raw.discovery_11d2)
  };
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value)
    .sort()
    .reduce((acc, key) => {
      acc[key] = sortKeysDeep(value[key]);
      return acc;
    }, {});
}

function stableMetadataFingerprint(rawExtract) {
  return JSON.stringify(sortKeysDeep(projectAzamaraWeeklySafeMetadata(rawExtract)));
}

function azamaraStableRawExtractEquivalent(left, right) {
  return stableMetadataFingerprint(left) === stableMetadataFingerprint(right);
}

function mergeAzamaraStableRawExtract(existingRaw, candidateRaw) {
  const merged = { ...(existingRaw || {}) };
  const projected = projectAzamaraWeeklySafeMetadata(candidateRaw);

  if (projected.title) merged.title = projected.title;
  if (projected.description) merged.description = projected.description;
  if (projected.excerpt) merged.excerpt = projected.excerpt;
  if (projected.canonical_url) merged.canonical_url = projected.canonical_url;
  if (projected.destination_name) merged.destination_name = projected.destination_name;
  if (projected.ship_name_guesses?.length) merged.ship_name_guesses = projected.ship_name_guesses;
  if (projected.azamara_package_code) merged.azamara_package_code = projected.azamara_package_code;
  if (projected.azamara_product_type) merged.azamara_product_type = projected.azamara_product_type;
  if (projected.azamara_gtm_duration) merged.azamara_gtm_duration = projected.azamara_gtm_duration;
  if (projected.structured_source) merged.structured_source = projected.structured_source;
  if (projected.departure_port_meta) {
    merged.departure_port_meta = {
      ...(merged.departure_port_meta || {}),
      ...projected.departure_port_meta
    };
  }
  if (projected.discovery_11d2) {
    merged.discovery_11d2 = {
      ...(merged.discovery_11d2 || {}),
      ...projected.discovery_11d2
    };
  }

  for (const key of VOLATILE_RAW_EXTRACT_KEYS) delete merged[key];
  merged.azamara_weekly_safe_update = true;
  return merged;
}

module.exports = {
  VOLATILE_RAW_EXTRACT_KEYS,
  projectAzamaraWeeklySafeMetadata,
  stableMetadataFingerprint,
  azamaraStableRawExtractEquivalent,
  mergeAzamaraStableRawExtract
};
