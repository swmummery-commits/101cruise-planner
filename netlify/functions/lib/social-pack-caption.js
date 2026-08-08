/**
 * Caption text for social carousel posts.
 * ~50 words, conversational voice, 5 hashtags — no prices, email, airline, or category.
 */

const { normaliseWhitespace, slugifyPart } = require("./social-pack-copy");

const PORT_ALIASES = {
  valletta: "Malta",
  piraeus: "Athens",
  "messina, sicily": "Messina",
  "mytilene, lesbos": "Mytilene",
  "santa cruz de la palma": "La Palma",
  "arrecife, lanzarote": "Lanzarote",
  "las palmas, gran canaria": "Gran Canaria",
  "ponta delgada, azores": "Azores",
  "royal naval dockyard": "Bermuda",
  "fort lauderdale (port everglades), florida": "Fort Lauderdale",
  "cagliari, sardinia": "Sardinia",
  "funchal, madeira": "Madeira",
  "heraklion, crete": "Crete",
  "southampton, england": "Southampton",
  "istanbul, turkey": "Istanbul",
  "rome, italy": "Rome",
  "lisbon, portugal": "Lisbon",
  "miami, florida": "Miami",
  "athens, greece": "Athens",
  "trieste, italy": "Trieste",
  "san juan": "San Juan",
  "puerto plata": "Puerto Plata"
};

const REGION_HOOKS = {
  mediterranean: "Time to get warm?",
  transatlantic: "Ready for an epic crossing?",
  caribbean: "Sun, sea and something special?",
  alaska: "Craving an adventure?",
  cruise: "Fancy something different?"
};

const REGION_LABELS = {
  mediterranean: "the Med",
  transatlantic: "the Atlantic",
  caribbean: "the Caribbean",
  alaska: "Alaska",
  cruise: "the open sea"
};

const REGION_PUNCH = {
  mediterranean: [
    "A beautifully balanced Mediterranean itinerary.",
    "Iconic landmarks. Lesser-known gems.",
    "Rich history and culture at every stop."
  ],
  transatlantic: [
    "Old-world ports. Open ocean. Warm welcomes ahead.",
    "An unforgettable voyage from Europe to sunshine."
  ],
  caribbean: [
    "Turquoise waters. Colourful ports. Pure relaxation.",
    "Island hopping at its very best."
  ],
  alaska: [
    "Glaciers, wildlife and scenery you'll never forget.",
    "Nature on a grand scale."
  ],
  cruise: [
    "Unforgettable ports. Beautiful scenery. Memories to last.",
    "The perfect blend of discovery and relaxation."
  ]
};

const GENERIC_HASHTAGS = ["CruiseHoliday", "TravelInspiration", "101Cruise", "GetYourCruiseOn"];

const REGION_HASHTAGS = {
  mediterranean: "MediterraneanCruise",
  transatlantic: "TransatlanticCruise",
  caribbean: "CaribbeanCruise",
  alaska: "AlaskaCruise",
  cruise: "CruiseTravel"
};

function shortenCity(port) {
  const raw = normaliseWhitespace(port);
  if (!raw) return "";
  const key = raw.toLowerCase();
  if (PORT_ALIASES[key]) return PORT_ALIASES[key];
  return raw.replace(/,.*$/, "").trim();
}

function buildShipDisplay(lineName, shipName) {
  const line = normaliseWhitespace(lineName);
  const ship = normaliseWhitespace(shipName);
  if (!ship) return line;
  if (/^seven seas/i.test(ship)) return ship;
  const brand = line.replace(/\s+Cruises?$/i, "").trim();
  if (!brand) return ship;
  const shipLower = ship.toLowerCase();
  const brandLower = brand.toLowerCase();
  if (shipLower.includes(brandLower) || shipLower.startsWith(brandLower.split(/\s+/)[0])) {
    return ship;
  }
  // Ship already names a different cruise line — do not prepend the record's line brand.
  const foreignBrands = [
    "celebrity",
    "regent",
    "princess",
    "holland america",
    "cunard",
    "seabourn",
    "silversea",
    "viking",
    "norwegian",
    "carnival",
    "royal caribbean",
    "msc",
    "oceania",
    "azamara",
    "windstar"
  ];
  for (const foreign of foreignBrands) {
    if (shipLower.includes(foreign) && !brandLower.includes(foreign.split(/\s+/)[0])) {
      return ship;
    }
  }
  return `${brand} ${ship}`;
}

function detectRegion(model) {
  const hay = [
    model.destinationStrip,
    model.journeyLine,
    model.headline,
    model.itinerarySummary,
    ...(model.ports || [])
  ]
    .join(" ")
    .toLowerCase();

  if (/alaska/i.test(hay)) return "alaska";
  if (/caribbean|san juan|bermuda|bahamas|arrecife|lanzarote|gran canaria|puerto plata/i.test(hay)) {
    if (/miami|fort lauderdale|transatlantic|southampton|lisbon|azores|bermuda|orlando/i.test(hay)) {
      return "transatlantic";
    }
    return "caribbean";
  }
  if (
    /mediterranean|\bmed\b|aegean|istanbul|rome|athens|greek|italy|turkey|malta|sicily|adriatic|mykonos|dubrovnik|split|kotor|trieste|marmaris|rhodes|lesbos|izmir|limassol/i.test(
      hay
    )
  ) {
    return "mediterranean";
  }
  if (/miami|fort lauderdale|florida|orlando/i.test(hay) && /lisbon|southampton|rome|europe|atlantic|azores|bermuda/i.test(hay)) {
    return "transatlantic";
  }
  return "cruise";
}

function dedupePorts(ports) {
  const seen = new Set();
  const out = [];
  for (const port of ports || []) {
    const short = shortenCity(port);
    if (!short) continue;
    const key = short.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(short);
  }
  return out;
}

function pickHighlightPorts(model, max = 4) {
  const ports = dedupePorts(model.ports);
  if (ports.length <= max) return ports;
  const dep = shortenCity(model.departurePort).toLowerCase();
  const arr = shortenCity(model.arrivalPort).toLowerCase();
  const middle = ports.filter((p, i) => {
    const key = p.toLowerCase();
    if (i === 0 && key === dep) return false;
    if (i === ports.length - 1 && key === arr) return false;
    return true;
  });
  const pool = middle.length >= 2 ? middle : ports.slice(1, -1).length ? ports.slice(1, -1) : ports;
  return pool.slice(0, max);
}

function formatPortList(ports) {
  if (!ports.length) return "";
  if (ports.length === 1) return ports[0];
  if (ports.length === 2) return `${ports[0]} and ${ports[1]}`;
  return `${ports.slice(0, -1).join(", ")} and ${ports[ports.length - 1]}`;
}

function nightsPhrase(nights) {
  const n = Number(nights);
  if (!Number.isFinite(n) || n < 1) return "";
  const v = Math.trunc(n);
  return `${v} night${v === 1 ? "" : "s"}`;
}

function lineHashtag(lineName) {
  const slug = slugifyPart(lineName || "cruise")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return slug || "CruiseLine";
}

function buildHashtags(model, region) {
  const tags = new Set();
  tags.add(REGION_HASHTAGS[region] || REGION_HASHTAGS.cruise);
  tags.add(lineHashtag(model.lineName));
  for (const tag of GENERIC_HASHTAGS) {
    if (tags.size >= 5) break;
    tags.add(tag);
  }
  while (tags.size < 5) tags.add("CruiseLife");
  return [...tags].slice(0, 5).map((t) => `#${t}`);
}

function countWords(text) {
  return String(text || "")
    .replace(/#\w+/g, "")
    .split(/\s+/)
    .filter(Boolean).length;
}

function buildCaption(model) {
  const region = detectRegion(model);
  const hook = REGION_HOOKS[region] || REGION_HOOKS.cruise;
  const regionLabel = REGION_LABELS[region] || REGION_LABELS.cruise;
  const ship = buildShipDisplay(model.lineName, model.shipName);
  const dep = shortenCity(model.departurePort || (model.ports || [])[0] || "");
  const arr = shortenCity(model.arrivalPort || (model.ports || []).slice(-1)[0] || "");
  const duration = nightsPhrase(model.nights);
  const highlights = pickHighlightPorts(model, 4);
  const portPhrase = formatPortList(highlights);

  const parts = [hook];

  const coreBits = [
    duration ? `How about ${duration} in ${regionLabel}` : `How about a voyage in ${regionLabel}`,
    ship ? `on board ${ship}` : "",
    dep && arr ? `from ${dep} to ${arr}` : dep || arr ? `from ${dep || arr}` : "",
    portPhrase ? `with ${portPhrase} along the way` : ""
  ].filter(Boolean);

  if (coreBits.length) parts.push(`${coreBits.join(" ")}.`);

  const punch = [...(REGION_PUNCH[region] || REGION_PUNCH.cruise)];
  const cta = 'Talk to Paul today and "get your cruise on".';
  while (punch.length && countWords([...parts, ...punch, cta].join(" ")) > 50) {
    punch.pop();
  }
  parts.push(...punch.slice(0, 2));

  parts.push(`${cta}`);

  const prose = parts.join(" ").replace(/\s+/g, " ").trim();
  const hashtags = buildHashtags(model, region);

  return `${prose}\n\n${hashtags.join(" ")}`.trim();
}

module.exports = {
  buildCaption,
  buildShipDisplay,
  detectRegion,
  shortenCity,
  pickHighlightPorts,
  buildHashtags
};
