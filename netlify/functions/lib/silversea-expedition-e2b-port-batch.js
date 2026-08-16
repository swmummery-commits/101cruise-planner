/**
 * Silversea Expedition Phase E2b — controlled endpoint + conventional port remediation.
 * Max 10 new canonical conventional ports. Logistics gateways use expedition mappings, not CSV ports.
 */

const MAX_E2B_CANONICAL_PORTS = 10;

/** @typedef {import("./silversea-canonical-port-batch").CanonicalPortSpec} CanonicalPortSpec */

/** @type {CanonicalPortSpec[]} */
const E2B_CANONICAL_PORT_CREATES = Object.freeze([
  {
    canonical_name: "Puerto Williams",
    display_name: "Puerto Williams, Chile",
    city: "Puerto Williams",
    country: "Chile",
    country_code: "CL",
    region: "Antarctica Gateway",
    latitude: -54.935,
    longitude: -67.604,
    aliases: ["Puerto Williams Chile"],
    silversea_source_name: "Puerto Williams",
    silversea_port_code: "CLWPU",
    evidence: "CLWPU is the genuine Beagle Channel embark/disembark harbour for Antarctica gateway voyages.",
    confidence: "high",
    affected_classic_sailings_estimate: 0,
    embark_sailings_estimate: 78,
    disembark_sailings_estimate: 78
  },
  {
    canonical_name: "Sisimiut",
    display_name: "Sisimiut, Greenland",
    city: "Sisimiut",
    country: "Greenland",
    country_code: "GL",
    region: "Arctic",
    latitude: 66.939,
    longitude: -53.669,
    aliases: ["Sisimiut Greenland"],
    silversea_source_name: "Sisimiut",
    silversea_port_code: "GLJHS",
    evidence: "GLJHS is Sisimiut harbour — genuine Greenland conventional port.",
    confidence: "high",
    affected_classic_sailings_estimate: 0,
    embark_sailings_estimate: 0,
    disembark_sailings_estimate: 0
  },
  {
    canonical_name: "Ilulissat",
    display_name: "Ilulissat, Greenland",
    city: "Ilulissat",
    country: "Greenland",
    country_code: "GL",
    region: "Arctic",
    latitude: 69.219,
    longitude: -51.098,
    aliases: ["Ilulissat Greenland"],
    silversea_source_name: "Ilulissat",
    silversea_port_code: "GLJAV",
    evidence: "GLJAV is Ilulissat Icefjord harbour — genuine Greenland conventional port.",
    confidence: "high",
    affected_classic_sailings_estimate: 0,
    embark_sailings_estimate: 0,
    disembark_sailings_estimate: 0
  },
  {
    canonical_name: "Rabaul",
    display_name: "Rabaul, Papua New Guinea",
    city: "Rabaul",
    country: "Papua New Guinea",
    country_code: "PG",
    region: "South Pacific",
    latitude: -4.199,
    longitude: 152.163,
    aliases: ["Rabaul Papua New Guinea"],
    silversea_source_name: "Rabaul",
    silversea_port_code: "PGRAB",
    evidence: "PGRAB is Rabaul harbour, New Britain — conventional PNG port.",
    confidence: "high",
    affected_classic_sailings_estimate: 0,
    embark_sailings_estimate: 0,
    disembark_sailings_estimate: 0
  },
  {
    canonical_name: "Santa Ana Island",
    display_name: "Santa Ana (Nendo), Solomon Islands",
    city: "Santa Ana",
    country: "Solomon Islands",
    country_code: "SB",
    region: "South Pacific",
    latitude: -10.848,
    longitude: 162.457,
    aliases: ["Santa Ana", "Santa Ana Solomon Islands", "Nendo"],
    silversea_source_name: "Santa Ana",
    silversea_port_code: "SBNNB",
    evidence: "SBNNB is Santa Ana/Nendo, Solomon Islands — not other global Santa Ana places.",
    confidence: "high",
    affected_classic_sailings_estimate: 0,
    embark_sailings_estimate: 0,
    disembark_sailings_estimate: 0
  },
  {
    canonical_name: "Iqaluit",
    display_name: "Iqaluit, Nunavut",
    city: "Iqaluit",
    country: "Canada",
    country_code: "CA",
    region: "Arctic",
    latitude: 63.747,
    longitude: -68.526,
    aliases: ["Iqaluit (Nunavut)", "Iqaluit Nunavut"],
    silversea_source_name: "Iqaluit (Nunavut)",
    silversea_port_code: "CAIQL",
    evidence: "CAIQL is Iqaluit Frobisher Bay — Northwest Passage expedition endpoint.",
    confidence: "high",
    affected_classic_sailings_estimate: 0,
    embark_sailings_estimate: 2,
    disembark_sailings_estimate: 2
  },
  {
    canonical_name: "Apra Harbor",
    display_name: "Apra Harbor, Guam",
    city: "Apra",
    country: "Guam",
    country_code: "GU",
    region: "Pacific",
    latitude: 13.443,
    longitude: 144.654,
    aliases: ["Apra", "Apra Guam"],
    silversea_source_name: "Apra",
    silversea_port_code: "GUAPR",
    evidence: "Silversea Apra is Apra Harbor, Guam — conventional Pacific port.",
    confidence: "high",
    affected_classic_sailings_estimate: 0,
    embark_sailings_estimate: 1,
    disembark_sailings_estimate: 1
  },
  {
    canonical_name: "Otaru",
    display_name: "Otaru, Japan",
    city: "Otaru",
    country: "Japan",
    country_code: "JP",
    region: "Japan",
    latitude: 43.19,
    longitude: 141.001,
    aliases: ["Otaru (Hokkaido)", "Otaru Hokkaido"],
    silversea_source_name: "Otaru (Hokkaido)",
    silversea_port_code: "JPOTR",
    evidence: "Silversea Otaru (Hokkaido) is the conventional Hokkaido cruise port.",
    confidence: "high",
    affected_classic_sailings_estimate: 0,
    embark_sailings_estimate: 1,
    disembark_sailings_estimate: 1
  },
  {
    canonical_name: "Tema",
    display_name: "Tema (Accra), Ghana",
    city: "Tema",
    country: "Ghana",
    country_code: "GH",
    region: "Africa",
    latitude: 5.669,
    longitude: -0.017,
    aliases: ["Tema (Accra)", "Tema Accra", "Tema Ghana"],
    silversea_source_name: "Tema (Accra)",
    silversea_port_code: "GHTEM",
    evidence: "Silversea Tema (Accra) is the Port of Tema — Ghana expedition endpoint.",
    confidence: "high",
    affected_classic_sailings_estimate: 0,
    embark_sailings_estimate: 1,
    disembark_sailings_estimate: 1
  }
]);

const E2B_EXISTING_PORT_ALIASES = Object.freeze([
  {
    canonical_name: "Tromso",
    aliases: ["Tromsø"],
    silversea_source_name: "Tromsø",
    silversea_port_code: "NOTOS",
    country: "Norway",
    evidence: "NOTOS is Tromsø; existing catalogue canonical Tromso already exists.",
    confidence: "high"
  }
]);

const E2B_SILVERSEA_ADAPTER_ALIASES = Object.freeze([
  {
    source_label: "tromsø",
    target_canonical: "Tromso",
    silversea_port_code: "NOTOS",
    evidence: "Adapter normalisation for Tromsø diacritic before catalogue lookup."
  }
]);

const E2B_LOGISTICS_GATEWAY_MAPPINGS = Object.freeze([
  {
    silversea_port_code: "AQKGG",
    gateway_name: "King George Island",
    classification: "EXPEDITION_LOGISTICS_GATEWAY",
    new_canonical: false,
    evidence: "Fly-cruise logistics gateway — not a conventional catalogue port."
  },
  {
    silversea_port_code: "AQKGI",
    gateway_name: "King George Island",
    classification: "EXPEDITION_LOGISTICS_GATEWAY",
    new_canonical: false,
    evidence: "Alternate code for King George Island logistics gateway."
  }
]);

const E2B_DEFERRED_IDENTITIES = Object.freeze([]);

function assertE2bManifestWithinLimit() {
  if (E2B_CANONICAL_PORT_CREATES.length > MAX_E2B_CANONICAL_PORTS) {
    throw new Error(`E2b canonical port count ${E2B_CANONICAL_PORT_CREATES.length} exceeds limit ${MAX_E2B_CANONICAL_PORTS}`);
  }
}

module.exports = {
  MAX_E2B_CANONICAL_PORTS,
  E2B_CANONICAL_PORT_CREATES,
  E2B_EXISTING_PORT_ALIASES,
  E2B_SILVERSEA_ADAPTER_ALIASES,
  E2B_LOGISTICS_GATEWAY_MAPPINGS,
  E2B_DEFERRED_IDENTITIES,
  assertE2bManifestWithinLimit
};
