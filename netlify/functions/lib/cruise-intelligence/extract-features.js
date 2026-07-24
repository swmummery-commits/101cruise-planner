/**
 * Extract deterministic scoring features from a CanonicalSailing (+ optional ship/line).
 * Only uses fields that exist — never invents unavailable attributes.
 */

function textBlob(sailing) {
  const parts = [
    sailing?.title,
    sailing?.cruiseLine?.canonicalName,
    sailing?.cruiseLine?.providerName,
    sailing?.ship?.canonicalName,
    sailing?.ship?.providerName,
    ...(sailing?.destinations || []),
    ...(sailing?.itinerary || []).map((s) => s.providerPortName || s.canonicalPortName || "")
  ];
  return parts
    .filter(Boolean)
    .join(" | ")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

function includesAny(haystack, needles) {
  return needles.some((n) => haystack.includes(String(n).toLowerCase()));
}

/**
 * @param {object} sailing CanonicalSailing-like
 * @param {{ shipRow?: object|null, lineRow?: object|null }} [enrichment]
 */
function extractFeatures(sailing, enrichment = {}) {
  const itinerary = Array.isArray(sailing?.itinerary) ? sailing.itinerary : [];
  const seaDays = itinerary.filter((s) => s.type === "sea").length;
  const scenicDays = itinerary.filter((s) => s.type === "scenic_cruising").length;
  const portDays = itinerary.filter(
    (s) => s.type === "port" || s.type === "embarkation" || s.type === "disembarkation"
  ).length;
  const ordinaryPorts = itinerary.filter(
    (s) => s.type === "embarkation" || s.type === "port" || s.type === "disembarkation"
  );
  const nights = sailing?.nights == null ? null : Number(sailing.nights);
  const blob = textBlob(sailing);

  const dep = ordinaryPorts[0];
  const arr = ordinaryPorts[ordinaryPorts.length - 1];
  const roundTrip =
    dep &&
    arr &&
    ((dep.portId && arr.portId && dep.portId === arr.portId) ||
      (dep.canonicalPortName &&
        arr.canonicalPortName &&
        String(dep.canonicalPortName).toLowerCase() === String(arr.canonicalPortName).toLowerCase()) ||
      (dep.providerPortName &&
        arr.providerPortName &&
        String(dep.providerPortName).toLowerCase() === String(arr.providerPortName).toLowerCase()));

  const ship = enrichment.shipRow || null;
  const line = enrichment.lineRow || null;
  let facilities = {};
  if (ship?.facilities) {
    if (typeof ship.facilities === "string") {
      try {
        facilities = JSON.parse(ship.facilities);
      } catch {
        facilities = {};
      }
    } else if (typeof ship.facilities === "object") {
      facilities = ship.facilities;
    }
  }

  const passengerCapacity =
    ship?.passenger_capacity == null || ship.passenger_capacity === ""
      ? null
      : Number(ship.passenger_capacity);
  const yearBuilt =
    ship?.year_built == null || ship.year_built === "" ? null : Number(ship.year_built);
  const shipAgeYears =
    yearBuilt && Number.isFinite(yearBuilt) ? new Date().getUTCFullYear() - yearBuilt : null;

  const lineName = String(
    sailing?.cruiseLine?.canonicalName || sailing?.cruiseLine?.providerName || line?.name || ""
  ).toLowerCase();

  const luxuryLines = [
    "silversea",
    "seabourn",
    "regent",
    "explora",
    "crystal",
    "oceania",
    "viking",
    "ponant"
  ];
  const mainstreamLines = [
    "carnival",
    "royal caribbean",
    "norwegian",
    "ncl",
    "msc",
    "princess",
    "celebrity",
    "holland america"
  ];
  const expeditionLines = ["hurtigruten", "ponant", "silversea", "viking"];

  return {
    nights: Number.isFinite(nights) ? nights : null,
    seaDays,
    scenicDays,
    portDays,
    itineraryLength: itinerary.length,
    roundTrip: Boolean(roundTrip),
    destinations: Array.isArray(sailing?.destinations) ? sailing.destinations.map(String) : [],
    title: String(sailing?.title || ""),
    cruiseLineName: String(sailing?.cruiseLine?.canonicalName || sailing?.cruiseLine?.providerName || ""),
    shipName: String(sailing?.ship?.canonicalName || sailing?.ship?.providerName || ""),
    blob,
    // Region / theme flags from text (deterministic substring rules)
    flags: {
      alaska: includesAny(blob, ["alaska", "juneau", "skagway", "ketchikan", "glacier bay", "seward", "whittier"]),
      caribbean: includesAny(blob, ["caribbean", "cozumel", "roatan", "bahamas", "grand turk", "st. thomas", "st thomas"]),
      mediterranean: includesAny(blob, ["mediterranean", "barcelona", "rome", "civitavecchia", "athens", "piraeus", "mykonos", "santorini", "venice", "istanbul"]),
      antarctica: includesAny(blob, ["antarctica", "antarctic"]),
      galapagos: includesAny(blob, ["galapagos", "galápagos"]),
      japan: includesAny(blob, ["japan", "tokyo", "yokohama", "osaka", "kobe", "hokkaido"]),
      norway_fjords: includesAny(blob, ["norway", "fjord", "bergen", "geiranger", "flam"]),
      australia_nz: includesAny(blob, ["australia", "sydney", "melbourne", "auckland", "new zealand", "queensland"]),
      pacific: includesAny(blob, ["pacific", "hawaii", "tahiti", "fiji", "samoa", "south pacific"]),
      panama_canal: includesAny(blob, ["panama canal"]),
      glacier: includesAny(blob, ["glacier"]),
      private_island: includesAny(blob, ["princess cays", "cococay", "half moon cay", "ocean cay", "private island"]),
      world_cruise: includesAny(blob, ["world cruise", "world cruise segment"]),
      unesco_proxy: includesAny(blob, ["ephesus", "kusadasi", "athens", "rome", "venice", "dubrovnik", "easter island", "rapa nui"])
    },
    ship: {
      passengerCapacity: Number.isFinite(passengerCapacity) ? passengerCapacity : null,
      yearBuilt: Number.isFinite(yearBuilt) ? yearBuilt : null,
      shipAgeYears: Number.isFinite(shipAgeYears) ? shipAgeYears : null,
      kidsClub: Boolean(facilities.kids_club),
      spa: Boolean(facilities.spa),
      casino: Boolean(facilities.casino),
      specialtyDining:
        facilities.specialty_dining == null ? null : Number(facilities.specialty_dining),
      restaurants: facilities.restaurants == null ? null : Number(facilities.restaurants),
      bars: facilities.bars == null ? null : Number(facilities.bars),
      theater: Boolean(facilities.theater),
      exclusiveAreas: Array.isArray(facilities.exclusive_areas)
        ? facilities.exclusive_areas.length
        : facilities.exclusive_areas
          ? 1
          : 0
    },
    line: {
      name: lineName,
      isLuxury: luxuryLines.some((l) => lineName.includes(l)),
      isMainstream: mainstreamLines.some((l) => lineName.includes(l)),
      isExpeditionBrand: expeditionLines.some((l) => lineName.includes(l)),
      lineType: line?.line_type || null,
      marketSegment: line?.market_segment || null
    }
  };
}

module.exports = {
  extractFeatures,
  textBlob
};
