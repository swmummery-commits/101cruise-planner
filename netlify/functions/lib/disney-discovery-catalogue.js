/**
 * Disney PAVAS — lossless product/itinerary catalogue merge (read-only).
 * Prevents last-write-wins loss when the same productId appears under different filters.
 */

const crypto = require("crypto");

function stableStringify(value) {
  if (value == null) return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function embeddedItinerarySample(itinerary = {}) {
  const sailings = Array.isArray(itinerary.sailings) ? itinerary.sailings : [];
  const sample = sailings[0] || {};
  return {
    destination: sample.destination != null ? String(sample.destination).trim().toUpperCase() : null,
    geoArea: sample.geoArea != null ? String(sample.geoArea).trim().toUpperCase() : null,
    numberOfNights: Number(sample.numberOfNights) || null,
    packageCode: sample.packageCode != null ? String(sample.packageCode).trim().toUpperCase() : null,
    shipCode: sample.ship?.seawareId != null ? String(sample.ship.seawareId).trim().toUpperCase() : null
  };
}

function itineraryStructuralParts(itinerary = {}, product = {}) {
  const ports = (Array.isArray(itinerary.portsOfCall) ? itinerary.portsOfCall : [])
    .map((p) => String(p).trim())
    .filter(Boolean)
    .sort();
  const sample = embeddedItinerarySample(itinerary);
  const themeId =
    product?.productItineraryData?.themeData?.id != null
      ? String(product.productItineraryData.themeData.id).trim()
      : itinerary?.themeData?.id != null
        ? String(itinerary.themeData.id).trim()
        : null;

  return {
    itineraryId: String(itinerary.itineraryId ?? ""),
    numberOfSailings: Number(itinerary.numberOfSailings) || 0,
    portsOfCall: ports,
    oneWayItinerary: Boolean(itinerary.oneWayItinerary),
    twoStopsItinerary: Boolean(itinerary.twoWayItinerary ?? itinerary.twoStopsItinerary),
    blockedFromBooking: Boolean(itinerary.blockedFromBooking),
    sampleDestination: sample.destination,
    sampleGeoArea: sample.geoArea,
    sampleNights: sample.numberOfNights,
    samplePackageCode: sample.packageCode,
    sampleShipCode: sample.shipCode,
    themeId
  };
}

function itineraryStructuralFingerprint(itinerary = {}, product = {}) {
  return stableStringify(itineraryStructuralParts(itinerary, product));
}

function productStructuralFingerprint(product = {}) {
  const itineraries = Array.isArray(product.itineraries) ? product.itineraries : [];
  return itineraries.map((it) => itineraryStructuralFingerprint(it, product)).sort().join("||");
}

function itineraryExpansionTargetKey(productId, itinerary = {}, product = {}) {
  const pid = String(productId || "").trim();
  const fp = itineraryStructuralFingerprint(itinerary, product);
  return `${pid}|${fp}`;
}

function productPageSignature(products = []) {
  return (products || []).map((p) => String(p?.productId || "")).join("|");
}

function productPageStructuralSignature(products = []) {
  const parts = [];
  for (const product of products || []) {
    const pid = String(product?.productId || "");
    const itineraries = Array.isArray(product.itineraries) ? product.itineraries : [];
    for (const itinerary of itineraries) {
      parts.push(itineraryExpansionTargetKey(pid, itinerary, product));
    }
  }
  parts.sort();
  return parts.join("|");
}

function hashSignature(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex").slice(0, 16);
}

class LosslessProductCatalogue {
  constructor() {
    /** @type {Map<string, {productId:string, productName:string|null, itineraries: Map<string, object>}>} */
    this.products = new Map();
    /** @type {Array<{productId:string, filters:string[], structuralFingerprint:string, itineraryKeys:string[]}>} */
    this.occurrences = [];
    this.structuralKeysSeen = new Set();
  }

  ingest(product, meta = {}) {
    if (!product?.productId) return { newProduct: false, newStructuralKeys: 0 };
    const productId = String(product.productId).trim();
    const filters = Array.isArray(meta.filters) ? meta.filters : [];
    const strategy = meta.strategy || null;

    if (!this.products.has(productId)) {
      this.products.set(productId, {
        productId,
        productName: product.productName || product.productDisplayName || null,
        itineraries: new Map()
      });
    }

    const entry = this.products.get(productId);
    if (!entry.productName && (product.productName || product.productDisplayName)) {
      entry.productName = product.productName || product.productDisplayName;
    }

    let newStructuralKeys = 0;
    const itineraryKeys = [];
    for (const itinerary of product.itineraries || []) {
      const key = itineraryExpansionTargetKey(productId, itinerary, product);
      itineraryKeys.push(key);
      if (!entry.itineraries.has(key)) {
        entry.itineraries.set(key, {
          ...itinerary,
          _expansionKey: key,
          _discoveredViaFilters: [...filters],
          _discoveredViaStrategy: strategy
        });
        if (!this.structuralKeysSeen.has(key)) {
          this.structuralKeysSeen.add(key);
          newStructuralKeys += 1;
        }
      } else {
        const existing = entry.itineraries.get(key);
        const mergedFilters = new Set([...(existing._discoveredViaFilters || []), ...filters]);
        existing._discoveredViaFilters = [...mergedFilters];
      }
    }

    this.occurrences.push({
      productId,
      filters,
      strategy,
      structuralFingerprint: productStructuralFingerprint(product),
      itineraryKeys
    });

    return {
      newProduct: itineraryKeys.length > 0 && newStructuralKeys > 0,
      newStructuralKeys
    };
  }

  get uniqueProductIds() {
    return this.products.size;
  }

  get uniqueItineraryTargets() {
    let count = 0;
    for (const entry of this.products.values()) count += entry.itineraries.size;
    return count;
  }

  getExpansionTargets() {
    const targets = [];
    for (const entry of this.products.values()) {
      for (const [key, itinerary] of entry.itineraries.entries()) {
        targets.push({
          productId: entry.productId,
          productName: entry.productName,
          itineraryId: itinerary.itineraryId ?? "",
          expansionKey: key,
          numberOfSailings: Number(itinerary.numberOfSailings) || 0,
          discoveredViaFilters: itinerary._discoveredViaFilters || [],
          discoveredViaStrategy: itinerary._discoveredViaStrategy || null,
          structuralFingerprint: itineraryStructuralFingerprint(itinerary, {
            productItineraryData: itinerary.productItineraryData
          }),
          itinerary
        });
      }
    }
    return targets;
  }

  lookupItineraryContexts(productId, itineraryId = "") {
    const entry = this.products.get(String(productId || "").trim());
    if (!entry) return [];
    const want = String(itineraryId ?? "");
    return [...entry.itineraries.values()].filter((it) => String(it.itineraryId ?? "") === want);
  }

  lookupByExpansionKey(expansionKey) {
    for (const entry of this.products.values()) {
      const it = entry.itineraries.get(expansionKey);
      if (it) {
        return {
          productId: entry.productId,
          productName: entry.productName,
          itinerary: it
        };
      }
    }
    return null;
  }

  toProductsArray() {
    return [...this.products.values()].map((entry) => ({
      productId: entry.productId,
      productName: entry.productName,
      productDisplayName: entry.productName,
      itineraries: [...entry.itineraries.values()].map(({ _expansionKey, _discoveredViaFilters, _discoveredViaStrategy, ...rest }) => rest)
    }));
  }

  simulateLastWriteWinsIngest(product) {
    if (!product?.productId) return;
    this._lww = this._lww || new Map();
    this._lww.set(String(product.productId), product);
  }

  finalizeLastWriteWinsTargets() {
    const lww = this._lww || new Map();
    const targets = [];
    for (const product of lww.values()) {
      for (const itinerary of product.itineraries || []) {
        targets.push({
          productId: product.productId,
          itineraryId: itinerary.itineraryId ?? ""
        });
      }
    }
    return targets;
  }
}

function analyzeProductVariantCollapse(catalogue, lastWriteWinsProducts = []) {
  const byProduct = new Map();
  for (const occ of catalogue.occurrences) {
    if (!byProduct.has(occ.productId)) byProduct.set(occ.productId, []);
    byProduct.get(occ.productId).push(occ);
  }

  let duplicateProductIdOccurrences = 0;
  let productIdsWithMultipleStructuralVariants = 0;
  const multiVariantDetails = [];

  for (const [productId, occs] of byProduct.entries()) {
    if (occs.length <= 1) continue;
    duplicateProductIdOccurrences += occs.length - 1;
    const fps = new Set(occs.map((o) => o.structuralFingerprint));
    if (fps.size > 1) {
      productIdsWithMultipleStructuralVariants += 1;
      multiVariantDetails.push({
        productId,
        occurrence_count: occs.length,
        structural_variant_count: fps.size,
        filters: occs.map((o) => ({ strategy: o.strategy, filters: o.filters }))
      });
    }
  }

  const lwwComparison = compareLastWriteWinsLoss(catalogue, lastWriteWinsProducts);

  return {
    duplicate_product_id_occurrences: duplicateProductIdOccurrences,
    product_ids_with_multiple_structural_variants: productIdsWithMultipleStructuralVariants,
    multi_variant_product_ids: multiVariantDetails.slice(0, 100),
    unique_product_ids: catalogue.uniqueProductIds,
    structural_product_variants: catalogue.uniqueItineraryTargets,
    lost_itineraries_recovered: Math.max(
      0,
      lwwComparison.itinerary_targets_after_fix - lwwComparison.itinerary_targets_before_fix
    ),
    ...lwwComparison
  };
}

function compareLastWriteWinsLoss(catalogue, lastWriteWinsProducts = []) {
  const losslessKeys = new Set(
    catalogue.getExpansionTargets().map((t) => t.expansionKey)
  );

  const lwwCatalogue = new LosslessProductCatalogue();
  for (const product of lastWriteWinsProducts) {
    lwwCatalogue.ingest(product, { filters: [], strategy: "last_write_wins" });
  }
  const lwwKeys = new Set(lwwCatalogue.getExpansionTargets().map((t) => t.expansionKey));

  const lostKeys = [...losslessKeys].filter((k) => !lwwKeys.has(k));
  let lostSailingCapacity = 0;
  for (const target of catalogue.getExpansionTargets()) {
    if (lostKeys.includes(target.expansionKey)) {
      lostSailingCapacity += target.numberOfSailings || 0;
    }
  }

  return {
    itinerary_targets_before_fix: lwwCatalogue.uniqueItineraryTargets,
    itinerary_targets_after_fix: catalogue.uniqueItineraryTargets,
    itineraries_lost_by_current_last_write_wins_logic: lostKeys.length,
    sailing_capacity_lost_by_current_last_write_wins_logic: lostSailingCapacity,
    lost_expansion_keys: lostKeys.slice(0, 50)
  };
}

function departureMonth(isoDate) {
  const d = String(isoDate || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.slice(0, 7) : null;
}

function groupSailingsByMonth(sailings = []) {
  const byMonth = new Map();
  for (const sailing of sailings) {
    const month = departureMonth(sailing.departure_date || sailing.sailDateFrom);
    if (!month) continue;
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(sailing);
  }
  return byMonth;
}

function analyzeTotalAvailableCruisesSemantics({ advertisedByMonth = {}, sailings = [], rawRows = [] }) {
  const byMonth = groupSailingsByMonth(sailings);
  const comparisons = [];

  for (const [month, advertised] of Object.entries(advertisedByMonth)) {
    const monthSailings = byMonth.get(month) || [];
    const uniqueSailingId = new Set(monthSailings.map((s) => s.sailing_id || s.sailingId).filter(Boolean)).size;
    const uniqueIdentity = new Set(
      monthSailings.map((s) => s.official_product_key || `${s.sailing_id}|${s.departure_date}`).filter(Boolean)
    ).size;
    const uniquePackageId = new Set(monthSailings.map((s) => s.package_id || s.packageId).filter(Boolean)).size;
    const uniquePackageCodeDate = new Set(
      monthSailings
        .map((s) => `${s.package_code || s.packageCode || ""}|${s.departure_date || s.sailDateFrom || ""}`)
        .filter((k) => !k.startsWith("|"))
    ).size;
    const sumEmbeddedNumberOfSailings = monthSailings.reduce((sum, s) => sum + (Number(s.numberOfSailings) || 0), 0);

    comparisons.push({
      month,
      advertised_total: advertised,
      unique_sailing_id: uniqueSailingId,
      unique_sailing_id_date: uniqueIdentity,
      unique_package_id: uniquePackageId,
      unique_package_code_date: uniquePackageCodeDate,
      matches_sailing_id_date: uniqueIdentity === advertised,
      matches_sailing_id: uniqueSailingId === advertised,
      matches_package_id: uniquePackageId === advertised,
      difference_identity: advertised - uniqueIdentity
    });
  }

  const totalAdvertised = Object.values(advertisedByMonth).reduce((a, b) => a + b, 0);
  const totalIdentity = new Set(sailings.map((s) => s.official_product_key).filter(Boolean)).size;
  const allMatchIdentity = comparisons.every((c) => c.matches_sailing_id_date);
  const allMatchSailingId = comparisons.every((c) => c.matches_sailing_id);

  let conclusion;
  let isUniqueDatedSailingCount = false;
  if (allMatchIdentity && totalIdentity === totalAdvertised) {
    conclusion = "totalAvailableCruises equals unique dated sailings (sailingId|YYYY-MM-DD) per month";
    isUniqueDatedSailingCount = true;
  } else if (allMatchSailingId) {
    conclusion = "totalAvailableCruises equals unique sailingId counts per month (not departure date)";
    isUniqueDatedSailingCount = false;
  } else {
    conclusion =
      "totalAvailableCruises does not consistently equal unique sailingId|date or sailingId alone — likely counts filter-scoped bookable sailing slots including duplicates across product facets";
    isUniqueDatedSailingCount = false;
  }

  return {
    conclusion,
    is_unique_dated_sailing_count: isUniqueDatedSailingCount,
    total_advertised_sum: totalAdvertised,
    total_unique_identities: totalIdentity,
    monthly_comparisons: comparisons,
    evidence: {
      all_months_match_identity: allMatchIdentity,
      all_months_match_sailing_id: allMatchSailingId
    }
  };
}

function buildPhase2HarvestPlans(filterIndex = {}) {
  const byType = filterIndex.byType || {};
  const plans = [];
  const seen = new Set();

  const addPlan = (strategy, filters) => {
    const key = [...filters].sort().join("\u0000");
    if (seen.has(key)) return;
    seen.add(key);
    plans.push({ strategy, filters: [...filters].sort() });
  };

  const pairTypes = [
    ["date", "ship"],
    ["date", "night"],
    ["date", "city"],
    ["date", "destination"],
    ["date", "theme"]
  ];

  for (const [left, right] of pairTypes) {
    for (const a of byType[left] || []) {
      for (const b of byType[right] || []) {
        addPlan(`${left}_x_${right}`, [a.filterValue, b.filterValue]);
      }
    }
  }

  for (const type of ["theme", "new-itineraries", "privateIsland"]) {
    for (const entry of byType[type] || []) {
      addPlan(`singleton_${type}`, [entry.filterValue]);
    }
  }

  for (const entry of byType.date || []) {
    addPlan("singleton_date", [entry.filterValue]);
  }

  return plans;
}

function dedupeFilterPlans(plans = []) {
  const seen = new Set();
  return plans.filter((plan) => {
    const key = `${plan.strategy}|${plan.filters.join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = {
  stableStringify,
  itineraryStructuralParts,
  itineraryStructuralFingerprint,
  productStructuralFingerprint,
  itineraryExpansionTargetKey,
  productPageSignature,
  productPageStructuralSignature,
  hashSignature,
  LosslessProductCatalogue,
  analyzeProductVariantCollapse,
  compareLastWriteWinsLoss,
  departureMonth,
  groupSailingsByMonth,
  analyzeTotalAvailableCruisesSemantics,
  buildPhase2HarvestPlans,
  dedupeFilterPlans
};
