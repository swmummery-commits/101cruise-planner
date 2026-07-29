/**
 * Safe destination matching + deterministic image rotation for Social Packs.
 * Never mutates Media Library. No random selection.
 */

const { normaliseWhitespace } = require("./social-pack-copy");

/** Canonical destination keys that exist (or may exist) in Media Library. */
const CANONICAL_DESTINATIONS = [
  "Antarctica",
  "Australia",
  "Bahamas",
  "Bali",
  "Barcelona",
  "Fiji",
  "Japan",
  "Lisbon",
  "Mediterranean",
  "New Zealand",
  "Norway",
  "Singapore",
  "Southeast Asia",
  "Istanbul",
  "Athens",
  "Palermo",
  "Rome",
  "Venice",
  "Dubrovnik",
  "Santorini",
  "Mykonos",
  "Paris",
  "London",
  "Sydney",
  "Auckland",
  "Queenstown",
  "Alaska",
  "Caribbean",
  "Hawaii",
  "Dubai"
];

/** Exact alias → canonical display name (case-insensitive keys). */
const ALIAS_TO_CANONICAL = {
  barcelona: "Barcelona",
  "barcelona spain": "Barcelona",
  istanbul: "Istanbul",
  "istanbul turkey": "Istanbul",
  lisbon: "Lisbon",
  "lisbon portugal": "Lisbon",
  singapore: "Singapore",
  "singapore singapore": "Singapore",
  fiji: "Fiji",
  "fiji islands": "Fiji",
  "the fiji islands": "Fiji",
  "new zealand": "New Zealand",
  "new zealand cruises": "New Zealand",
  mediterranean: "Mediterranean",
  "mediterranean & aegean": "Mediterranean",
  "mediterranean and aegean": "Mediterranean",
  "mediterranean aegean": "Mediterranean",
  "southeast asia": "Southeast Asia",
  "south east asia": "Southeast Asia",
  "south-east asia": "Southeast Asia",
  antarctica: "Antarctica",
  australia: "Australia",
  bahamas: "Bahamas",
  "the bahamas": "Bahamas",
  bali: "Bali",
  japan: "Japan",
  norway: "Norway",
  athens: "Athens",
  "athens greece": "Athens",
  "piraeus athens": "Athens",
  piraeus: "Athens",
  palermo: "Palermo",
  "palermo sicily": "Palermo",
  "palermo sicily italy": "Palermo"
};

/** City/port → broader region used only after exact pools fail. */
const CITY_TO_REGION = {
  Barcelona: "Mediterranean",
  Istanbul: "Mediterranean",
  Athens: "Mediterranean",
  Palermo: "Mediterranean",
  Rome: "Mediterranean",
  Venice: "Mediterranean",
  Dubrovnik: "Mediterranean",
  Santorini: "Mediterranean",
  Mykonos: "Mediterranean",
  Lisbon: "Mediterranean",
  Bali: "Southeast Asia",
  Singapore: "Southeast Asia",
  Sydney: "Australia",
  Auckland: "New Zealand",
  Queenstown: "New Zealand"
};

function stripDiacritics(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normaliseDestinationKey(value) {
  return stripDiacritics(normaliseWhitespace(value))
    .toLowerCase()
    .replace(/[|/·•]+/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Resolve a free-text place name to a canonical destination label.
 * Exact aliases only — no unsafe substring guessing.
 */
function resolveCanonicalDestination(raw) {
  const key = normaliseDestinationKey(raw);
  if (!key) return null;

  if (ALIAS_TO_CANONICAL[key]) return ALIAS_TO_CANONICAL[key];

  // Unambiguous country suffix strip: "Barcelona Spain" / "Barcelona, Spain"
  const countrySuffixes = [
    "spain",
    "portugal",
    "turkey",
    "greece",
    "italy",
    "france",
    "croatia",
    "australia",
    "new zealand",
    "indonesia",
    "japan",
    "norway",
    "singapore",
    "fiji",
    "usa",
    "united states",
    "uk",
    "united kingdom"
  ];
  for (const suffix of countrySuffixes) {
    if (key.endsWith(" " + suffix)) {
      const trimmed = key.slice(0, -(suffix.length + 1)).trim();
      if (ALIAS_TO_CANONICAL[trimmed]) return ALIAS_TO_CANONICAL[trimmed];
      const title = titleCaseCanonical(trimmed);
      if (CANONICAL_DESTINATIONS.some((d) => normaliseDestinationKey(d) === trimmed)) {
        return title;
      }
    }
  }

  const exactCanonical = CANONICAL_DESTINATIONS.find((d) => normaliseDestinationKey(d) === key);
  if (exactCanonical) return exactCanonical;

  return null;
}

function titleCaseCanonical(key) {
  return String(key || "")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function regionForCanonical(canonical) {
  if (!canonical) return null;
  if (CITY_TO_REGION[canonical]) return CITY_TO_REGION[canonical];
  if (canonical === "Mediterranean" || canonical === "Southeast Asia") return canonical;
  return null;
}

/**
 * Build ordered candidate keys for a cruise (exact → arrival → departure → regional → itinerary).
 */
function buildDestinationCandidateKeys(cruise = {}, ports = []) {
  const keys = [];
  const seen = new Set();
  function push(raw, role) {
    const canonical = resolveCanonicalDestination(raw);
    if (!canonical) return;
    const norm = normaliseDestinationKey(canonical);
    if (seen.has(norm)) return;
    seen.add(norm);
    keys.push({ canonical, role, raw: String(raw || "").trim() });
  }

  // Featured destination strip often "Barcelona to Istanbul"
  const strip = String(cruise.destination_strip || cruise.destinationStrip || "");
  if (strip) {
    const parts = strip.split(/\s+to\s+/i);
    if (parts.length >= 2) {
      push(parts[0], "featured_departure");
      push(parts[parts.length - 1], "featured_arrival");
    } else {
      push(strip, "featured");
    }
  }

  push(cruise.arrival_port || cruise.arrivalPort, "arrival");
  push(cruise.departure_port || cruise.departurePort, "departure");

  for (const port of ports || []) {
    const label = typeof port === "string" ? port : port?.port_label || port?.name || "";
    push(label, "itinerary");
  }

  // Regional after exact city keys already listed
  const regionSeen = new Set();
  for (const entry of [...keys]) {
    const region = regionForCanonical(entry.canonical);
    if (!region) continue;
    const norm = normaliseDestinationKey(region);
    if (regionSeen.has(norm) || seen.has(norm)) continue;
    regionSeen.add(norm);
    seen.add(norm);
    keys.push({ canonical: region, role: "regional", raw: region });
  }

  return keys;
}

function mediaMatchesDestination(row, canonical) {
  if (!row || !canonical) return false;
  const mediaKey = resolveCanonicalDestination(row.destination_name || row.title || "");
  if (!mediaKey) return false;
  return normaliseDestinationKey(mediaKey) === normaliseDestinationKey(canonical);
}

/**
 * Stable ordering of eligible destination media for a canonical name.
 * active only → default first → created_at → id
 */
function sortDestinationMedia(rows) {
  return [...(rows || [])].sort((a, b) => {
    const aDef = a.is_default ? 0 : 1;
    const bDef = b.is_default ? 0 : 1;
    if (aDef !== bDef) return aDef - bDef;
    const aCreated = String(a.created_at || "");
    const bCreated = String(b.created_at || "");
    if (aCreated !== bCreated) return aCreated.localeCompare(bCreated);
    return String(a.id || "").localeCompare(String(b.id || ""));
  });
}

function filterActiveDestinationMedia(rows, canonical) {
  return sortDestinationMedia(
    (rows || []).filter(
      (row) =>
        row &&
        row.is_active !== false &&
        row.media_type === "destination" &&
        mediaMatchesDestination(row, canonical)
    )
  );
}

/**
 * rotation_index = (newsletter_number + cruise_display_order - 1) % count
 */
function rotationIndex({ newsletterNumber, displayOrder, count }) {
  const n = Math.max(0, Math.trunc(Number(newsletterNumber) || 0));
  const order = Math.max(1, Math.trunc(Number(displayOrder) || 1));
  const c = Math.max(0, Math.trunc(Number(count) || 0));
  if (c <= 0) return 0;
  return (n + order - 1) % c;
}

/**
 * Resolve the best destination image pool and selected media for a cruise.
 *
 * @param {object} options
 * @param {object} options.cruise
 * @param {string[]} options.ports
 * @param {Array} options.destinationMedia - active destination media rows
 * @param {string|null} options.manualMediaId - preview override
 * @param {object|null} options.featuredHeroMedia
 * @param {string|null} options.featuredHeroUrl
 * @param {object|null} options.shipHero - { url }
 */
function resolveSocialBackground(options = {}) {
  const cruise = options.cruise || {};
  const ports = options.ports || [];
  const allDest = (options.destinationMedia || []).filter(
    (m) => m && m.is_active !== false && m.media_type === "destination"
  );
  const newsletterNumber = cruise.newsletter_number ?? cruise.newsletterNumber ?? 0;
  const displayOrder = cruise.display_order ?? cruise.displayOrder ?? 1;

  if (options.manualMediaId) {
    const manual = allDest.find((m) => m.id === options.manualMediaId) || options.manualMedia;
    if (manual?.public_url) {
      return {
        status: "ok",
        source: "manual",
        matchRole: "manual",
        destinationKey: resolveCanonicalDestination(manual.destination_name) || manual.destination_name || null,
        candidates: [manual],
        candidateCount: 1,
        rotationIndex: 0,
        media: manual,
        warning: null
      };
    }
  }

  const keyPlan = buildDestinationCandidateKeys(cruise, ports);
  const pools = [];

  for (const entry of keyPlan) {
    const matches = filterActiveDestinationMedia(allDest, entry.canonical);
    if (!matches.length) continue;
    pools.push({
      canonical: entry.canonical,
      role: entry.role,
      media: matches
    });
  }

  // Prefer exact city pools before regional
  const roleRank = {
    featured: 0,
    featured_arrival: 1,
    arrival: 2,
    featured_departure: 3,
    departure: 4,
    itinerary: 5,
    regional: 6
  };
  pools.sort((a, b) => {
    const ra = roleRank[a.role] ?? 50;
    const rb = roleRank[b.role] ?? 50;
    if (ra !== rb) return ra - rb;
    // Within same rank, prefer larger exact pools? Keep plan order.
    return 0;
  });

  // Prefer departure/arrival exact over regional: already ranked.
  // For Barcelona→Istanbul prefer Barcelona or Istanbul or Mediterranean.
  // Featured arrival/departure from strip may duplicate arrival/departure — first pool wins.

  if (pools.length) {
    // Prefer non-regional if any exist
    const preferred = pools.find((p) => p.role !== "regional") || pools[0];
    const idx = rotationIndex({
      newsletterNumber,
      displayOrder,
      count: preferred.media.length
    });
    const selected = preferred.media[idx];
    return {
      status: "ok",
      source: "destination",
      matchRole: preferred.role,
      destinationKey: preferred.canonical,
      candidates: preferred.media,
      candidateCount: preferred.media.length,
      rotationIndex: idx,
      media: selected,
      pools: pools.map((p) => ({
        canonical: p.canonical,
        role: p.role,
        count: p.media.length
      })),
      warning: null
    };
  }

  // Fallback: Featured Cruise hero
  if (options.featuredHeroMedia?.public_url || options.featuredHeroUrl) {
    const media = options.featuredHeroMedia || {
      id: null,
      title: "Featured Cruise hero",
      public_url: options.featuredHeroUrl,
      destination_name: null
    };
    return {
      status: "ok",
      source: "featured_hero",
      matchRole: "featured_hero_fallback",
      destinationKey: null,
      candidates: [media],
      candidateCount: 1,
      rotationIndex: 0,
      media,
      warning: "No safe destination image pool — using Featured Cruise hero."
    };
  }

  // Final fallback: ship hero
  if (options.shipHero?.url) {
    return {
      status: "ok",
      source: "ship_hero",
      matchRole: "ship_hero_fallback",
      destinationKey: null,
      candidates: [
        {
          id: null,
          title: "Ship hero",
          public_url: options.shipHero.url
        }
      ],
      candidateCount: 1,
      rotationIndex: 0,
      media: {
        id: null,
        title: "Ship hero",
        public_url: options.shipHero.url
      },
      warning: "No destination or Featured Cruise image — using ship hero."
    };
  }

  return {
    status: "blocked",
    source: null,
    matchRole: null,
    destinationKey: null,
    candidates: [],
    candidateCount: 0,
    rotationIndex: 0,
    media: null,
    warning: "No safe destination image pool exists for this cruise."
  };
}

/**
 * Build picker sections for Admin Social Image picker.
 */
function buildDestinationPickerSections(options = {}) {
  const cruise = options.cruise || {};
  const ports = options.ports || [];
  const allDest = (options.destinationMedia || []).filter(
    (m) => m && m.is_active !== false && m.media_type === "destination" && m.public_url
  );
  const keyPlan = buildDestinationCandidateKeys(cruise, ports);
  const byRole = {
    recommended: [],
    current_destination: [],
    arrival: [],
    departure: [],
    regional: [],
    all: sortDestinationMedia(allDest)
  };

  const arrivalKeys = keyPlan.filter((k) => k.role === "arrival" || k.role === "featured_arrival");
  const departureKeys = keyPlan.filter((k) => k.role === "departure" || k.role === "featured_departure");
  const regionalKeys = keyPlan.filter((k) => k.role === "regional");
  const exactKeys = keyPlan.filter((k) => k.role !== "regional");

  function collect(keys) {
    const out = [];
    const seen = new Set();
    for (const k of keys) {
      for (const row of filterActiveDestinationMedia(allDest, k.canonical)) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        out.push(row);
      }
    }
    return out;
  }

  byRole.arrival = collect(arrivalKeys);
  byRole.departure = collect(departureKeys);
  byRole.regional = collect(regionalKeys);
  byRole.current_destination = collect(exactKeys.filter((k) => k.role !== "itinerary"));
  byRole.recommended = collect(exactKeys.concat(regionalKeys));

  // Fallbacks in recommended only when destination pools empty
  if (!byRole.recommended.length) {
    if (options.featuredHeroMedia?.public_url) {
      byRole.recommended.push({
        ...options.featuredHeroMedia,
        _fallback: "featured_hero"
      });
    }
  }

  return byRole;
}

module.exports = {
  CANONICAL_DESTINATIONS,
  ALIAS_TO_CANONICAL,
  CITY_TO_REGION,
  normaliseDestinationKey,
  resolveCanonicalDestination,
  regionForCanonical,
  buildDestinationCandidateKeys,
  mediaMatchesDestination,
  sortDestinationMedia,
  filterActiveDestinationMedia,
  rotationIndex,
  resolveSocialBackground,
  buildDestinationPickerSections
};
