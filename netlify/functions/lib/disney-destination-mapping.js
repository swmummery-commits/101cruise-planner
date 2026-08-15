/**
 * Disney PAVAS destination hints → operational destination slugs.
 */

const DISNEY_DESTINATION_CODE_SLUG = Object.freeze({
  BAHAMAS: "caribbean",
  CARIBBEAN: "caribbean",
  ALASKA: "alaska",
  EUROPE: "mediterranean",
  MEDITERRANEAN: "mediterranean",
  MEXICO: "mexican-riviera",
  HAWAII: "hawaii",
  SINGAPORE: "asia",
  AUSTRALIA: "australia-new-zealand",
  "SOUTH PACIFIC": "south-pacific",
  PANAMA: "panama-canal",
  TRANSATLANTIC: "transatlantic"
});

const DISNEY_GEO_AREA_SLUG = Object.freeze({
  ALASKA: "alaska",
  BAHAMAS: "caribbean",
  CARIBBEAN: "caribbean",
  "WEST CARIBBEAN": "caribbean",
  "EAST CARIBBEAN": "caribbean",
  "SOUTH CARIBBEAN": "caribbean",
  EUROPE: "mediterranean",
  "WEST EUROPE A": "northern-europe",
  "WEST EUROPE B": "northern-europe",
  "NORTHERN EUROPE": "northern-europe",
  MEDITERRANEAN: "mediterranean",
  "GREEK ISLES": "mediterranean",
  MEXICO: "mexican-riviera",
  "PACIFIC COAST": "pacific-coast",
  HAWAII: "hawaii",
  SINGAPORE: "asia",
  ASIA: "asia",
  "SOUTH PACIFIC": "south-pacific",
  PANAMA: "panama-canal",
  "PANAMA CANAL": "panama-canal"
});

function resolveDisneyDestinationHints(raw = {}) {
  const destCode = String(raw.destination_code || "").trim().toUpperCase();
  const geoArea = String(raw.geo_area || "").trim().toUpperCase();
  const productName = String(raw.product_name || "").trim();
  const productId = String(raw.product_id || "").trim().toLowerCase();
  const ports = (raw.ports_of_call || []).join(" ").toLowerCase();

  if (/alaska|vancouver|juneau|ketchikan|skagway|icy strait/i.test(`${productId} ${productName} ${ports}`)) {
    return { preferredSlug: "alaska", method: "disney_route_alaska" };
  }
  if (/transatlantic|southampton.*fort lauderdale|fort lauderdale.*southampton/i.test(productId)) {
    return { preferredSlug: "transatlantic", method: "disney_product_transatlantic" };
  }
  if (/panama|galveston.*san diego|san diego.*galveston/i.test(productId)) {
    return { preferredSlug: "panama-canal", method: "disney_product_panama" };
  }
  if (/singapore|baja|mexican_riviera|san_diego|vancouver.*san_diego/i.test(productId)) {
    if (/mexican|baja|riviera/i.test(productId)) {
      return { preferredSlug: "mexican-riviera", method: "disney_product_mexico_pacific" };
    }
    if (/pacific_coast|vancouver.*san_diego/i.test(productId)) {
      return { preferredSlug: "pacific-coast", method: "disney_product_pacific_coast" };
    }
    if (/singapore/i.test(productId)) {
      return { preferredSlug: "asia", method: "disney_product_singapore" };
    }
  }
  if (/bahamian|bahamas|castaway|lookout cay|nassau|fort_lauderdale|port_canaveral|galveston/i.test(productId)) {
    return { preferredSlug: "caribbean", method: "disney_product_caribbean_bahamas" };
  }
  if (/european|mediterranean|barcelona|civitavecchia|southampton|british_isles|norwegian_fjords|adriatic|greek/i.test(productId)) {
    if (/norwegian_fjords|british_isles|southampton/i.test(productId) && !/mediterranean|barcelona|civitavecchia|adriatic|greek/i.test(productId)) {
      return { preferredSlug: "northern-europe", method: "disney_product_northern_europe" };
    }
    return { preferredSlug: "mediterranean", method: "disney_product_europe" };
  }

  if (DISNEY_GEO_AREA_SLUG[geoArea]) {
    return { preferredSlug: DISNEY_GEO_AREA_SLUG[geoArea], method: `disney_geo_area_${geoArea}` };
  }
  if (DISNEY_DESTINATION_CODE_SLUG[destCode]) {
    return { preferredSlug: DISNEY_DESTINATION_CODE_SLUG[destCode], method: `disney_destination_code_${destCode}` };
  }

  if (destCode) {
    return { structuredDestination: destCode.replace(/_/g, " "), method: "disney_destination_code_raw" };
  }
  return {};
}

module.exports = {
  DISNEY_DESTINATION_CODE_SLUG,
  DISNEY_GEO_AREA_SLUG,
  resolveDisneyDestinationHints
};
