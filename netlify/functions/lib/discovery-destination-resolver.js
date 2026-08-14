/**
 * Shared operational destination resolver for Discovery and Cruise Finder classification.
 * Separates internal classification from public Living Destination publication.
 */

const { normaliseName } = require("./cruise-finder-v2/enrichment/match-entities");
const {
  classificationDestinations,
  precedenceRank,
  catalogueEntryBySlug
} = require("./destination-classification");
const { portHintsForText, scoreDestinationsFromPortHints } = require("./destination-port-mappings");

const DESTINATION_RESOLVER_VERSION = "2026-08-02.operational4";

function slugForDestination(destinations, slugNeedle) {
  const needle = normaliseName(slugNeedle).replace(/\s+/g, "-");
  return classificationDestinations(destinations).find((d) => normaliseName(d.slug) === needle) || null;
}

function destBySlugOrKey(destinations, slug) {
  const fromDb = slugForDestination(destinations, slug);
  if (fromDb) return fromDb;
  const cat = catalogueEntryBySlug(slug);
  if (cat) {
    return {
      id: null,
      name: cat.name,
      slug: cat.slug,
      primary_region: cat.primary_region,
      classification_enabled: cat.classification_enabled,
      status: cat.public_status,
      _catalogue_key: cat.key
    };
  }
  return null;
}

function scoreTextSignals(blob, destinations) {
  const scores = new Map();
  const hay = normaliseName(blob);
  if (!hay) return scores;

  for (const dest of classificationDestinations(destinations)) {
    const name = normaliseName(dest.name);
    const slug = normaliseName(dest.slug).replace(/-/g, " ");
    const region = normaliseName(dest.primary_region || "");
    let score = 0;
    if (name && hay.includes(` ${name} `)) score += 90;
    else if (name && hay.includes(name)) score += 75;
    if (slug && hay.includes(slug)) score += 70;
    if (region && region.length > 4 && hay.includes(region)) score += 40;
    if (score) scores.set(dest.slug, Math.max(scores.get(dest.slug) || 0, score));
  }

  for (const cat of require("./destination-classification").OPERATIONAL_DESTINATION_CATALOGUE) {
    if (!cat.classification_enabled) continue;
    for (const signal of cat.route_signals || []) {
      const sig = normaliseName(signal);
      if (sig && hay.includes(sig)) {
        scores.set(cat.slug, Math.max(scores.get(cat.slug) || 0, 65));
      }
    }
  }
  return scores;
}

function mergeScores(...maps) {
  const out = new Map();
  for (const m of maps) {
    for (const [slug, score] of m.entries()) {
      out.set(slug, Math.max(out.get(slug) || 0, score));
    }
  }
  return out;
}

function pickWinner(scores, { minScore = 70, allowLowForCrossing = false } = {}) {
  if (!scores.size) return null;
  const ranked = [...scores.entries()]
    .map(([slug, score]) => ({ slug, score, precedence: precedenceRank(slug) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.precedence - b.precedence;
    });
  const top = ranked[0];
  const second = ranked[1];
  const crossingSlugs = new Set(["transpacific", "transatlantic", "world-cruise"]);
  const threshold =
    top && crossingSlugs.has(top.slug) && allowLowForCrossing ? 55 : minScore;
  if (!top || top.score < threshold) return null;
  if (second && second.score === top.score && second.precedence === top.precedence) {
    return { ambiguous: true, candidates: ranked.slice(0, 3) };
  }
  if (second && top.score - second.score < 8 && second.precedence < top.precedence) {
    const crossingWins =
      crossingSlugs.has(top.slug) || crossingSlugs.has(second.slug);
    if (!crossingWins && top.score - second.score < 5) {
      return { ambiguous: true, candidates: ranked.slice(0, 3) };
    }
  }
  return { slug: top.slug, score: top.score, candidates: ranked.slice(0, 3) };
}

function parseTitleRegionLabel(title) {
  const parts = String(title || "").split("|").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const segment = parts[parts.length - 2] || parts[1];
  const norm = normaliseName(segment);
  // Explicit region only — broad marketing labels like "The Americas & Caribbean" are weak hints.
  if (/^caribbean|eastern caribbean|western caribbean|southern caribbean/.test(norm)) {
    return { slug: "caribbean", score: 88, method: "title_region_label" };
  }
  if (/americas.*caribbean|caribbean.*americas/.test(norm)) {
    return { slug: "caribbean", score: 45, method: "title_region_label_weak" };
  }
  if (/pacific coast|california coast|pacific northwest|west coast/.test(norm)) {
    return { slug: "pacific-coast", score: 88, method: "title_region_label" };
  }
  if (/alaska/.test(norm)) return { slug: "alaska", score: 88, method: "title_region_label" };
  if (/transoceanic|transpacific/.test(norm)) return { slug: "transpacific", score: 90, method: "title_region_label" };
  if (/mediterranean|northern europe/.test(norm)) return { slug: "mediterranean", score: 85, method: "title_region_label" };
  return null;
}

function extractStructuredDestination(structuredDestination) {
  if (!structuredDestination) return null;
  const text = String(structuredDestination).trim();
  if (!text) return null;
  return { text, method: "structured_destination", confidence: 95 };
}

function detectPacificCoastRoute(title, description, itinerary, departurePort, arrivalPort) {
  const hay = normaliseName([title, description, itinerary, departurePort, arrivalPort].filter(Boolean).join(" "));
  const alaskaSignals = ["juneau", "ketchikan", "sitka", "skagway", "seward", "whittier", "hubbard", "glacier bay"];
  if (alaskaSignals.filter((p) => hay.includes(p)).length >= 2) return null;

  const pacificCoastTokens = [
    "san diego",
    "los angeles",
    "long beach",
    "san francisco",
    "seattle",
    "vancouver",
    "victoria",
    "portland",
    "astoria",
    "monterey",
    "santa barbara"
  ];
  const dep = normalisePortToken(departurePort);
  const arr = normalisePortToken(arrivalPort);
  const endpoints = [dep, arr].filter(Boolean);
  if (endpoints.length >= 2 && endpoints[0] === endpoints[1]) {
    return null;
  }
  if (endpoints.length < 2) {
    const routeMatch = String(title || "").match(/([A-Za-z][A-Za-z\s]{2,30}?)\s+to\s+([A-Za-z][A-Za-z\s]{2,30}?)(?:\s*\||\s+on\s|\s*$)/i);
    if (routeMatch) {
      endpoints.push(normalisePortToken(routeMatch[1]), normalisePortToken(routeMatch[2]));
    }
  }
  const pacificHits = endpoints.filter((e) => pacificCoastTokens.some((p) => e.includes(p)));
  if (pacificHits.length >= 2) {
    return { slug: "pacific-coast", score: 92, method: "endpoint_pacific_coast" };
  }
  if (
    (dep.includes("san diego") && arr.includes("vancouver")) ||
    (dep.includes("vancouver") && arr.includes("san diego"))
  ) {
    return { slug: "pacific-coast", score: 93, method: "endpoint_pacific_coast" };
  }
  return null;
}

function detectCrossingRoute(title, description, itinerary, departurePort, arrivalPort) {
  const blob = normaliseName([title, description, itinerary, departurePort, arrivalPort].filter(Boolean).join(" "));
  if (!blob) return null;
  if (/world cruise|grand voyage|world voyage|around the world cruise/.test(blob)) {
    return { slug: "world-cruise", score: 92, method: "voyage_type_world" };
  }
  if (/transoceanic|transpacific|crossing the pacific|pacific ocean crossing|pacific crossing|north pacific crossing|north america to asia|asia to north america/i.test(blob)) {
    return { slug: "transpacific", score: 92, method: "voyage_type_transpacific" };
  }
  if (/transatlantic|crossing the atlantic|atlantic crossing/.test(blob)) {
    return { slug: "transatlantic", score: 88, method: "voyage_type_transatlantic" };
  }
  const dep = normalisePortToken(departurePort);
  const arr = normalisePortToken(arrivalPort);
  const pacificPairs = [
    ["yokohama", "seward"],
    ["yokohama", "anchorage"],
    ["tokyo", "seward"],
    ["tokyo", "vancouver"],
    ["seward", "tokyo"],
    ["vancouver", "tokyo"],
    ["yokohama", "vancouver"]
  ];
  for (const [a, b] of pacificPairs) {
    if ((dep.includes(a) && arr.includes(b)) || (dep.includes(b) && arr.includes(a))) {
      return { slug: "transpacific", score: 90, method: "endpoint_transpacific" };
    }
  }

  // Shared Europe ↔ North America Atlantic endpoint crossing (same idea as Celebrity port-crossing).
  // Only fires when endpoints are on opposite sides — Europe↔Europe coastal hops stay unresolved here.
  const europeAtlantic = [
    "southampton",
    "hamburg",
    "lisbon",
    "barcelona",
    "civitavecchia",
    "rome",
    "venice",
    "copenhagen",
    "reykjavik",
    "amsterdam",
    "rotterdam",
    "le havre",
    "warnemunde",
    "stockholm",
    "piraeus",
    "athens",
    "istanbul"
  ];
  const northAmericaAtlantic = [
    "new york",
    "miami",
    "fort lauderdale",
    "quebec",
    "boston",
    "cape liberty",
    "montreal",
    "halifax"
  ];
  const euDep = europeAtlantic.some((t) => dep.includes(t));
  const euArr = europeAtlantic.some((t) => arr.includes(t));
  const naDep = northAmericaAtlantic.some((t) => dep.includes(t));
  const naArr = northAmericaAtlantic.some((t) => arr.includes(t));
  if ((euDep && naArr) || (naDep && euArr)) {
    return { slug: "transatlantic", score: 90, method: "endpoint_transatlantic" };
  }
  return null;
}

function normalisePortToken(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const ANTARCTICA_ROUTE_SIGNAL_RES = [
  /\bantarctic experience\b/i,
  /\bdrake passage\b/i,
  /\bantarctic peninsula\b/i,
  /\bsouth shetland islands?\b/i,
  /\belephant island\b/i,
  /\bdeception island\b/i,
  /\bross sea\b/i,
  /\bweddell sea\b/i,
  /\bamundsen sea\b/i,
  /\bthe seabourn antarctic experience\b/i
];

/**
 * True when title/itinerary/ports show Antarctica — not HAL's broad
 * "South America & Antarctica" marketing category alone.
 */
function hasAntarcticaRouteEvidence({
  title = "",
  description = "",
  itinerary = "",
  itinerary_ports = [],
  departurePort = null,
  arrivalPort = null
} = {}) {
  const portList = Array.isArray(itinerary_ports) ? itinerary_ports.join("\n") : "";
  const blob = [title, description, itinerary, portList, departurePort, arrivalPort].filter(Boolean).join("\n");

  for (const re of ANTARCTICA_ROUTE_SIGNAL_RES) {
    if (re.test(blob)) return true;
  }

  const panamaCanalOnly =
    /\bpanama canal\b/i.test(blob) &&
    !/\b(drake passage|antarctic experience|antarctic peninsula)\b/i.test(blob);

  if (panamaCanalOnly) return false;

  if (/\bantarctica\b/i.test(blob)) return true;

  return false;
}

function resolveOperationalDestination({
  title = "",
  description = "",
  itinerary = "",
  structuredDestination = null,
  departurePort = null,
  arrivalPort = null,
  nights = null,
  destinationAliases = [],
  destinations = [],
  preferredDestination = null
} = {}) {
  const evidence = [];

  if (preferredDestination?.id || preferredDestination?.slug) {
    const dest = preferredDestination.id
      ? classificationDestinations(destinations).find((d) => d.id === preferredDestination.id)
      : destBySlugOrKey(destinations, preferredDestination.slug);
    if (dest && isClassifiable(dest)) {
      const hasAntarcticaEvidence = hasAntarcticaRouteEvidence({
        title,
        description,
        itinerary,
        departurePort,
        arrivalPort
      });
      if (dest.slug !== "antarctica" || hasAntarcticaEvidence) {
        return resultFromDest(dest, "high", ["preferred_scope"], evidence);
      }
    }
  }

  const titleRegion = parseTitleRegionLabel(title);
  if (titleRegion) {
    evidence.push({ type: "title_region", detail: titleRegion.method, weight: titleRegion.score });
  }
  const structured = extractStructuredDestination(structuredDestination);
  if (structured) {
    evidence.push({ type: "structured", detail: structured.text, weight: 95 });
  }

  const blob = [title, description, itinerary].filter(Boolean).join("\n");
  const portBlob = [itinerary, description, title, departurePort, arrivalPort].filter(Boolean).join("\n");
  const hayNorm = normaliseName(portBlob);

  const crossing = detectCrossingRoute(title, description, itinerary, departurePort, arrivalPort);
  const pacificCoast = detectPacificCoastRoute(title, description, itinerary, departurePort, arrivalPort);
  if (crossing) {
    evidence.push({ type: "crossing_route", detail: crossing.method, weight: crossing.score });
  }
  if (pacificCoast) {
    evidence.push({ type: "pacific_coast_route", detail: pacificCoast.method, weight: pacificCoast.score });
  }

  const portHints = portHintsForText(portBlob);
  const portScores = scoreDestinationsFromPortHints(portHints);
  if (portHints.length) {
    evidence.push({
      type: "itinerary_ports",
      detail: portHints.map((p) => p.port).join(", "),
      weight: 70
    });
  }

  const textScores = scoreTextSignals(blob, destinations);
  if (structured?.text) {
    const structScores = scoreTextSignals(structured.text, destinations);
    for (const [slug, score] of structScores.entries()) {
      textScores.set(slug, Math.max(textScores.get(slug) || 0, score + 15));
    }
  }

  for (const alias of destinationAliases || []) {
    const needle = normaliseName(alias.normalised_alias || alias.raw_alias);
    if (needle && normaliseName(blob).includes(needle)) {
      const dest = destinations.find((d) => d.id === alias.destination_id);
      if (dest && isClassifiable(dest)) {
        evidence.push({ type: "alias", detail: alias.raw_alias, weight: 92 });
        textScores.set(dest.slug, Math.max(textScores.get(dest.slug) || 0, 92));
      }
    }
  }

  let merged = mergeScores(portScores, textScores);
  if (titleRegion && titleRegion.score >= 70) {
    merged.set(titleRegion.slug, Math.max(merged.get(titleRegion.slug) || 0, titleRegion.score));
    if (titleRegion.slug === "caribbean" || titleRegion.slug === "transpacific") merged.delete("alaska");
  }
  if (pacificCoast) {
    merged.set(pacificCoast.slug, Math.max(merged.get(pacificCoast.slug) || 0, pacificCoast.score));
    merged.delete("caribbean");
    if (!hayNorm.match(/\b(juneau|ketchikan|sitka|skagway|seward|whittier|hubbard)\b/)) {
      merged.delete("alaska");
    }
  }
  if (crossing) {
    merged.set(crossing.slug, Math.max(merged.get(crossing.slug) || 0, crossing.score));
    const explicitAlaska = /\balaska\b/.test(normaliseName([title, structured?.text].filter(Boolean).join(" ")));
    const alaskaPortCount = ["juneau", "ketchikan", "sitka", "skagway", "hubbard", "glacier"].filter((p) =>
      hayNorm.includes(p)
    ).length;
    if (
      (crossing.slug === "transpacific" || crossing.slug === "transatlantic") &&
      !explicitAlaska &&
      alaskaPortCount < 2
    ) {
      merged.delete("alaska");
    }
  }

  const alaskaPorts = ["juneau", "ketchikan", "sitka", "skagway", "hubbard", "glacier"];
  const japanPorts = ["tokyo", "yokohama", "osaka", "kobe", "hiroshima"];
  const alaskaCount = alaskaPorts.filter((p) => hayNorm.includes(p)).length;
  const japanCount = japanPorts.filter((p) => hayNorm.includes(p)).length;
  if (alaskaCount >= 2 && japanCount >= 1) {
    merged.set("transpacific", Math.max(merged.get("transpacific") || 0, 95));
    evidence.push({ type: "multi_region", detail: "alaska_and_japan_ports", weight: 95 });
    merged.delete("alaska");
    merged.delete("japan");
  } else if (alaskaCount >= 1 && (japanCount >= 1 || /\bjapanese\b|\bjapan grace\b/.test(hayNorm))) {
    merged.set("transpacific", Math.max(merged.get("transpacific") || 0, 96));
    evidence.push({ type: "multi_region", detail: "alaska_and_japan_route", weight: 96 });
    merged.delete("alaska");
    merged.delete("japan");
  }

  const isTransoceanicTitle = /transoceanic|transpacific|crossing the pacific/i.test(title);
  const explicitAlaskaTitle =
    !isTransoceanicTitle &&
    /\balaska\b/.test(normaliseName(title)) &&
    !/\b(japan|japanese|grand journey)\b/.test(normaliseName(title));
  if (explicitAlaskaTitle) {
    merged.set("alaska", Math.max(merged.get("alaska") || 0, 92));
  } else if (isTransoceanicTitle) {
    merged.set("transpacific", Math.max(merged.get("transpacific") || 0, 92));
    merged.delete("alaska");
  }

  if (departurePort && !itinerary && !String(description || "").match(/alaska|japan|transpacific/i)) {
    const depOnly = normalisePortToken(departurePort);
    if (["vancouver", "seattle", "tokyo", "yokohama"].includes(depOnly)) {
      merged.delete("alaska");
      if (depOnly === "tokyo" || depOnly === "yokohama") merged.delete("japan");
    }
  }

  const winner = pickWinner(merged, { allowLowForCrossing: Boolean(crossing) });
  if (winner?.ambiguous) {
    return {
      destinationId: null,
      destinationName: null,
      destinationKey: null,
      confidence: "low",
      evidence,
      status: "ambiguous",
      candidates: winner.candidates.map((c) => ({ slug: c.slug, score: c.score })),
      resolverVersion: DESTINATION_RESOLVER_VERSION
    };
  }
  if (!winner?.slug) {
    return {
      destinationId: null,
      destinationName: null,
      destinationKey: null,
      confidence: null,
      evidence,
      status: "unresolved",
      candidates: [],
      resolverVersion: DESTINATION_RESOLVER_VERSION
    };
  }

  const dest = destBySlugOrKey(destinations, winner.slug);
  if (!dest) {
    return {
      destinationId: null,
      destinationName: catalogueEntryBySlug(winner.slug)?.name || winner.slug,
      destinationKey: winner.slug,
      confidence: winner.score >= 85 ? "high" : winner.score >= 70 ? "medium" : "low",
      evidence,
      status: "resolved",
      candidates: winner.candidates.map((c) => ({ slug: c.slug, score: c.score })),
      resolverVersion: DESTINATION_RESOLVER_VERSION,
      catalogueOnly: true
    };
  }

  return resultFromDest(
    dest,
    winner.score >= 85 ? "high" : winner.score >= 70 ? "medium" : "low",
    evidence.map((e) => e.type),
    evidence,
    winner.candidates
  );
}

function isClassifiable(dest) {
  if (!dest) return false;
  if (dest.classification_enabled === false) return false;
  if (dest.status === "archived" || dest.status === "hidden") return false;
  return true;
}

function resultFromDest(dest, confidence, methods, evidence, candidates = []) {
  return {
    destinationId: dest.id || null,
    destinationName: dest.name,
    destinationKey: dest.slug || dest._catalogue_key,
    confidence,
    evidence: [...evidence, ...methods.map((m) => ({ type: "method", detail: m }))],
    status: "resolved",
    candidates: candidates.map((c) => ({ slug: c.slug, score: c.score })),
    resolverVersion: DESTINATION_RESOLVER_VERSION,
    catalogueOnly: !dest.id
  };
}

/** Backward-compatible wrapper for discovery-auto-resolver. */
function resolveDestination(args) {
  const result = resolveOperationalDestination(args);
  return {
    resolved: result.status === "resolved" && (result.destinationId || result.destinationKey),
    destination_id: result.destinationId,
    destination_name: result.destinationName,
    destination_key: result.destinationKey,
    confidence: result.confidence === "high" ? 95 : result.confidence === "medium" ? 80 : 60,
    method: result.evidence?.[0]?.type || result.status,
    status: result.status,
    candidates: result.candidates,
    catalogue_only: result.catalogueOnly || false,
    resolverVersion: result.resolverVersion
  };
}

module.exports = {
  DESTINATION_RESOLVER_VERSION,
  resolveOperationalDestination,
  resolveDestination,
  detectCrossingRoute,
  detectPacificCoastRoute,
  scoreTextSignals,
  pickWinner,
  hasAntarcticaRouteEvidence
};
