/**
 * Operational destination classification vs public Living Destination publication.
 *
 * - classification_enabled: internal Discovery / Cruise Finder matching
 * - status (draft | published | hidden): public Living Destination visibility
 */

const { normaliseName } = require("./cruise-finder-v2/enrichment/match-entities");

/** Proposed operational catalogue keys (seed manifest references these slugs). */
const OPERATIONAL_DESTINATION_CATALOGUE = [
  {
    key: "alaska",
    name: "Alaska",
    slug: "alaska",
    classification_enabled: true,
    public_status: "published",
    primary_region: "North America",
    parent_region: null,
    aliases: ["alaskan", "inside passage", "hubbard glacier"],
    representative_ports: ["Juneau", "Ketchikan", "Sitka", "Skagway", "Whittier", "Seward", "Seattle"],
    route_signals: ["alaska", "inside passage", "hubbard glacier", "glacier bay"],
    exclusions: ["vancouver to tokyo without alaska ports", "transpacific only"],
    cruise_finder_immediate: true,
    living_destination_required: false
  },
  {
    key: "caribbean",
    name: "Caribbean",
    slug: "caribbean",
    classification_enabled: true,
    public_status: "draft",
    primary_region: "Caribbean",
    parent_region: null,
    aliases: ["eastern caribbean", "western caribbean", "southern caribbean"],
    representative_ports: ["Miami", "Fort Lauderdale", "San Juan", "Bridgetown", "St Thomas"],
    route_signals: ["caribbean", "bahamas", "antilles"],
    exclusions: ["mediterranean only"],
    cruise_finder_immediate: true,
    living_destination_required: true
  },
  {
    key: "mediterranean",
    name: "Mediterranean",
    slug: "mediterranean",
    classification_enabled: true,
    public_status: "draft",
    primary_region: "Europe",
    parent_region: "europe",
    aliases: ["med", "western mediterranean", "eastern mediterranean"],
    representative_ports: ["Barcelona", "Rome", "Civitavecchia", "Venice", "Athens", "Piraeus", "Santorini"],
    route_signals: ["mediterranean", "aegean", "adriatic", "tyrrhenian"],
    exclusions: ["norwegian fjords only", "transatlantic only"],
    cruise_finder_immediate: true,
    living_destination_required: true
  },
  {
    key: "northern-europe",
    name: "Northern Europe",
    slug: "northern-europe",
    classification_enabled: true,
    public_status: "draft",
    primary_region: "Europe",
    parent_region: "europe",
    aliases: ["northern european", "scandinavia"],
    representative_ports: ["Copenhagen", "Stockholm", "Hamburg", "Amsterdam", "Rotterdam"],
    route_signals: ["northern europe", "baltic sea", "scandinavia"],
    exclusions: ["mediterranean only"],
    cruise_finder_immediate: false,
    living_destination_required: true
  },
  {
    key: "norwegian-fjords",
    name: "Norwegian Fjords",
    slug: "norwegian-fjords",
    classification_enabled: true,
    public_status: "draft",
    primary_region: "Europe",
    parent_region: "northern-europe",
    aliases: ["norway fjords", "fjords"],
    representative_ports: ["Bergen", "Geiranger", "Flam", "Oslo"],
    route_signals: ["norwegian fjords", "geiranger", "fjord"],
    exclusions: ["mediterranean"],
    cruise_finder_immediate: false,
    living_destination_required: true
  },
  {
    key: "british-isles",
    name: "British Isles",
    slug: "british-isles",
    classification_enabled: true,
    public_status: "draft",
    primary_region: "Europe",
    parent_region: "northern-europe",
    aliases: ["uk ireland", "britain ireland"],
    representative_ports: ["Southampton", "Dublin", "Edinburgh", "Liverpool"],
    route_signals: ["british isles", "ireland", "scotland"],
    exclusions: [],
    cruise_finder_immediate: false,
    living_destination_required: true
  },
  {
    key: "canada-new-england",
    name: "Canada and New England",
    slug: "canada-new-england",
    classification_enabled: true,
    public_status: "draft",
    primary_region: "North America",
    parent_region: null,
    aliases: ["new england canada", "fall foliage"],
    representative_ports: ["Quebec City", "Montreal", "Boston", "Halifax", "Bar Harbor"],
    route_signals: ["canada new england", "new england", "fall foliage"],
    exclusions: ["alaska only"],
    cruise_finder_immediate: false,
    living_destination_required: true
  },
  {
    key: "japan",
    name: "Japan",
    slug: "japan",
    classification_enabled: true,
    public_status: "draft",
    primary_region: "Asia",
    parent_region: "asia",
    aliases: ["japanese", "tokyo", "yokohama", "osaka"],
    representative_ports: ["Tokyo", "Yokohama", "Osaka", "Kobe", "Hiroshima"],
    route_signals: ["japan", "japanese", "honshu", "kyushu"],
    exclusions: ["tokyo departure alone without japan ports"],
    cruise_finder_immediate: true,
    living_destination_required: true
  },
  {
    key: "asia",
    name: "Asia",
    slug: "asia",
    classification_enabled: true,
    public_status: "draft",
    primary_region: "Asia",
    parent_region: null,
    aliases: ["southeast asia", "far east"],
    representative_ports: ["Singapore", "Hong Kong", "Ho Chi Minh City", "Bangkok"],
    route_signals: ["asia", "southeast asia"],
    exclusions: ["japan-dominant itineraries → japan"],
    cruise_finder_immediate: true,
    living_destination_required: true
  },
  {
    key: "australia-new-zealand",
    name: "Australia and New Zealand",
    slug: "australia-new-zealand",
    classification_enabled: true,
    public_status: "draft",
    primary_region: "Oceania",
    parent_region: null,
    aliases: ["australasia", "down under"],
    representative_ports: ["Sydney", "Auckland", "Melbourne", "Wellington", "Bay of Islands"],
    route_signals: ["australia", "new zealand", "australasia"],
    exclusions: ["south pacific only island hops"],
    cruise_finder_immediate: true,
    living_destination_required: true
  },
  {
    key: "south-pacific",
    name: "South Pacific",
    slug: "south-pacific",
    classification_enabled: true,
    public_status: "draft",
    primary_region: "Oceania",
    parent_region: null,
    aliases: ["pacific islands", "polynesia"],
    representative_ports: ["Papeete", "Bora Bora", "Fiji", "Noumea"],
    route_signals: ["south pacific", "tahiti", "fiji", "polynesia"],
    exclusions: ["australia nz dominant → australia-new-zealand"],
    cruise_finder_immediate: false,
    living_destination_required: true
  },
  {
    key: "hawaii",
    name: "Hawaii",
    slug: "hawaii",
    classification_enabled: true,
    public_status: "draft",
    primary_region: "Pacific",
    parent_region: null,
    aliases: ["hawaiian islands", "honolulu"],
    representative_ports: ["Honolulu", "Maui", "Kona", "Hilo"],
    route_signals: ["hawaii", "hawaiian"],
    exclusions: [],
    cruise_finder_immediate: false,
    living_destination_required: true
  },
  {
    key: "antarctica",
    name: "Antarctica",
    slug: "antarctica",
    classification_enabled: true,
    public_status: "draft",
    primary_region: "Polar",
    parent_region: null,
    aliases: ["antarctic", "peninsula"],
    representative_ports: ["Ushuaia", "Port Stanley", "Punta Arenas"],
    route_signals: ["antarctica", "antarctic peninsula", "drake passage"],
    exclusions: ["patagonia only without antarctic landing"],
    cruise_finder_immediate: false,
    living_destination_required: true
  },
  {
    key: "transatlantic",
    name: "Transatlantic",
    slug: "transatlantic",
    classification_enabled: true,
    public_status: "draft",
    primary_region: "Ocean crossing",
    parent_region: null,
    aliases: ["crossing the atlantic", "repositioning atlantic"],
    representative_ports: ["Southampton", "New York", "Barcelona", "Fort Lauderdale"],
    route_signals: ["transatlantic", "crossing the atlantic", "atlantic crossing"],
    exclusions: ["mediterranean coastal only"],
    cruise_finder_immediate: false,
    living_destination_required: true
  },
  {
    key: "transpacific",
    name: "Transpacific",
    slug: "transpacific",
    classification_enabled: true,
    public_status: "draft",
    primary_region: "Ocean crossing",
    parent_region: null,
    aliases: ["pacific crossing", "crossing the pacific", "transoceanic"],
    representative_ports: ["Tokyo", "Yokohama", "Vancouver", "Seattle", "Seward", "Sydney", "San Francisco"],
    route_signals: ["transpacific", "transoceanic", "crossing the pacific", "pacific ocean crossing"],
    exclusions: ["alaska coastal only without pacific crossing"],
    cruise_finder_immediate: false,
    living_destination_required: true
  },
  {
    key: "world-cruise",
    name: "World Cruise",
    slug: "world-cruise",
    classification_enabled: true,
    public_status: "draft",
    primary_region: "Global",
    parent_region: null,
    aliases: ["grand voyage", "world voyage", "around the world"],
    representative_ports: [],
    route_signals: ["world cruise", "grand voyage", "world voyage"],
    exclusions: [],
    cruise_finder_immediate: false,
    living_destination_required: true
  },
  {
    key: "panama-canal",
    name: "Panama Canal",
    slug: "panama-canal",
    classification_enabled: true,
    public_status: "draft",
    primary_region: "Central America",
    parent_region: null,
    aliases: ["canal transit", "panama"],
    representative_ports: ["Colon", "Panama City", "Cartagena"],
    route_signals: ["panama canal", "canal transit"],
    exclusions: [],
    cruise_finder_immediate: false,
    living_destination_required: true
  },
  {
    key: "mexican-riviera",
    name: "Mexican Riviera",
    slug: "mexican-riviera",
    classification_enabled: true,
    public_status: "draft",
    primary_region: "North America",
    parent_region: null,
    aliases: ["mexico pacific"],
    representative_ports: ["Cabo San Lucas", "Puerto Vallarta", "Mazatlan", "San Diego"],
    route_signals: ["mexican riviera", "baja"],
    exclusions: ["san diego to vancouver repositioning → pacific-coast"],
    cruise_finder_immediate: false,
    living_destination_required: true
  },
  {
    key: "pacific-coast",
    name: "Pacific Coast",
    slug: "pacific-coast",
    classification_enabled: true,
    public_status: "draft",
    primary_region: "North America",
    parent_region: null,
    aliases: ["california coast", "pacific northwest", "west coast"],
    representative_ports: ["San Diego", "Los Angeles", "San Francisco", "Seattle", "Vancouver", "Victoria"],
    route_signals: ["pacific coast", "california coast", "pacific northwest", "west coast"],
    exclusions: [
      "alaska-dominant itineraries → alaska",
      "yokohama or tokyo endpoints → transpacific",
      "caribbean marketing labels without caribbean ports"
    ],
    cruise_finder_immediate: true,
    living_destination_required: true
  },
  {
    key: "galapagos",
    name: "Galapagos",
    slug: "galapagos",
    classification_enabled: true,
    public_status: "draft",
    primary_region: "South America",
    parent_region: null,
    aliases: ["galapagos islands"],
    representative_ports: ["Baltra", "San Cristobal"],
    route_signals: ["galapagos"],
    exclusions: ["general south america"],
    cruise_finder_immediate: false,
    living_destination_required: true
  }
];

/**
 * Precedence when multiple regions match (lower index = higher priority for tie-break).
 * Broader crossing types beat incidental region mentions.
 */
const DESTINATION_PRECEDENCE = [
  "world-cruise",
  "transpacific",
  "transatlantic",
  "panama-canal",
  "galapagos",
  "antarctica",
  "norwegian-fjords",
  "british-isles",
  "mediterranean",
  "northern-europe",
  "alaska",
  "canada-new-england",
  "pacific-coast",
  "hawaii",
  "mexican-riviera",
  "japan",
  "asia",
  "australia-new-zealand",
  "south-pacific",
  "caribbean"
];

function isClassificationEnabled(dest) {
  if (!dest) return false;
  if (dest.classification_enabled === false) return false;
  if (dest.status === "archived" || dest.status === "hidden") return false;
  return true;
}

/** Cruise Finder inventory may use draft classification-enabled destinations (name/slug only). */
function isInventoryDestination(dest) {
  return isClassificationEnabled(dest);
}

function isPublicLivingDestination(dest) {
  return Boolean(dest && dest.status === "published");
}

function classificationDestinations(destinations) {
  return (destinations || []).filter(isClassificationEnabled);
}

function publicLivingDestinations(destinations) {
  return (destinations || []).filter(isPublicLivingDestination);
}

function catalogueEntryBySlug(slug) {
  const needle = normaliseName(slug).replace(/\s+/g, "-");
  return OPERATIONAL_DESTINATION_CATALOGUE.find((d) => d.slug === needle) || null;
}

function precedenceRank(slug) {
  const idx = DESTINATION_PRECEDENCE.indexOf(slug);
  return idx === -1 ? 999 : idx;
}

module.exports = {
  OPERATIONAL_DESTINATION_CATALOGUE,
  DESTINATION_PRECEDENCE,
  isClassificationEnabled,
  isInventoryDestination,
  isPublicLivingDestination,
  classificationDestinations,
  publicLivingDestinations,
  catalogueEntryBySlug,
  precedenceRank
};
