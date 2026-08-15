/**
 * Carnival Cruise Line — region-code destination mapping (AU cruise-search API).
 *
 * Prefer stable `regionCode` over marketing labels. Reuses existing 101cruise
 * operational destination slugs only — no Carnival-specific top-level destinations.
 */

const CCL_REGION_CODE_SLUG = Object.freeze({
  A: "alaska",
  AB: "australia-new-zealand",
  AJ: "transpacific",
  BF: "south-pacific",
  BH: "caribbean",
  BI: "british-isles",
  BM: "caribbean",
  C: "caribbean",
  CE: "caribbean",
  CG: "mediterranean",
  CP: "caribbean",
  CS: "caribbean",
  CW: "caribbean",
  E: "mediterranean",
  EC: "mediterranean",
  EN: "northern-europe",
  ES: "northern-europe",
  ET: "transatlantic",
  FS: "south-pacific",
  GB: "australia-new-zealand",
  GE: "australia-new-zealand",
  GI: "mediterranean",
  GL: "alaska",
  H: "hawaii",
  IB: "mediterranean",
  KI: "australia-new-zealand",
  KB: "australia-new-zealand",
  M: "mexican-riviera",
  MB: "mexican-riviera",
  MC: "australia-new-zealand",
  ME: "mediterranean",
  MI: "australia-new-zealand",
  MR: "mexican-riviera",
  NI: "australia-new-zealand",
  NN: "canada-new-england",
  NO: "canada-new-england",
  NV: "south-pacific",
  NZ: "australia-new-zealand",
  O: "south-pacific",
  PI: "australia-new-zealand",
  S: "south-america",
  SA: "australia-new-zealand",
  T: "panama-canal",
  TH: "transpacific",
  TP: "transpacific",
  U: "australia-new-zealand",
  VN: "south-pacific",
  X: "asia",
  XS: "asia"
});

function resolveCclDestinationHints(raw) {
  const code = String(raw?.region_code || raw?.regionCode || "").trim().toUpperCase();
  const slug = code ? CCL_REGION_CODE_SLUG[code] : null;
  if (slug) {
    return { preferredSlug: slug, method: `ccl_region_code_${code}` };
  }

  const label = String(raw?.region_name || raw?.regionName || "").trim();
  if (label) return { structuredDestination: label, method: "ccl_region_name" };
  return {};
}

module.exports = {
  CCL_REGION_CODE_SLUG,
  resolveCclDestinationHints
};
