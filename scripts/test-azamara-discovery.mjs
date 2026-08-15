#!/usr/bin/env node
/**
 * Azamara discovery — cruisetour exclusion, GTM duration, validation hardening.
 * Run: npm run test:azamara-discovery
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const {
  classifyAzamaraProduct,
  parseAzamaraGtmDuration,
  extractAzamaraGtmFromHtml,
  enrichStructuredVoyageFromHtml,
  validateAzamaraOceanDuration,
  isAzamaraCruiseLine,
  azamaraPreBuildGate,
  AZAMARA_LINE_ID
} = require(path.join(root, "netlify/functions/lib/azamara-discovery-source"));
const {
  buildCandidateFromSource,
  pickDestinationFromHits,
  matchDestination
} = require(path.join(root, "netlify/functions/lib/cruise-discovery"));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const azamaraLine = { id: AZAMARA_LINE_ID, name: "Azamara", slug: "azamara" };

assert(isAzamaraCruiseLine(azamaraLine), "Azamara line detected");

const cta = classifyAzamaraProduct({
  packageCode: "PR270705-014-CTA01",
  url: "https://www.azamara.com/cruises/pr270705-014-cta01-alaska-explorer-cruisetour-denali",
  title: "ALASKA EXPLORER CRUISETOUR: DENALI, TALKEETNA, RIVERBOAT & RAIL",
  description: "Explore this Alaska Explorer Cruisetour sailing post-cruise land programme"
});
assert(cta.productType === "cruisetour", "CTA classified cruisetour");
assert(cta.exclusionReason === "policy_excluded_cruisetour", "CTA excluded");

const ctb = classifyAzamaraProduct({
  packageCode: "QS270511-013-CTB01",
  url: "https://www.azamara.com/cruises/qs270511-013-ctb01-banff-cruisetour",
  title: "BANFF CRUISETOUR: JOURNEY THROUGH THE ROCKIES",
  description: "Pre-cruise land programme with hotel stay"
});
assert(ctb.productType === "cruisetour", "CTB classified cruisetour");
assert(ctb.exclusionReason === "policy_excluded_cruisetour", "CTB excluded");

const ocean = classifyAzamaraProduct({
  packageCode: "JR270707-013",
  url: "https://www.azamara.com/cruises/jr270707-013-british-isles-cruise",
  title: "BRITISH ISLES CRUISE: LIVERPOOL, DUBLIN & EDINBURGH",
  description: "Explore this British Isles Cruise sailing from PORTSMOUTH"
});
assert(ocean.productType === "ocean_cruise", "standard ocean remains eligible");
assert(!ocean.exclusionReason, "standard ocean not excluded");

const combo = classifyAzamaraProduct({
  packageCode: "QS280105-077",
  url: "https://www.azamara.com/cruises/qs280105-077-circle-south-america-combination-cruise",
  title: "CIRCLE SOUTH AMERICA COMBINATION CRUISE",
  description: "Explore this combination cruise across South America"
});
assert(combo.productType === "ocean_combination", "combination cruise eligible type");
assert(!combo.exclusionReason, "combination not excluded");

const combo2 = classifyAzamaraProduct({
  packageCode: "QS260913-031",
  title: "MEDITERRANEAN COMBINATION CRUISE: BARCELONA, VENICE & ATHENS",
  description: "Explore this Mediterranean Combination Cruise"
});
assert(!combo2.exclusionReason, "QS260913-031 not excluded");

assert(parseAzamaraGtmDuration("13-NIGHT CRUISE") === 13, "GTM duration parses to 13");
assert(parseAzamaraGtmDuration("7-NIGHT CRUISE") === 7, "GTM duration parses to 7");
assert(parseAzamaraGtmDuration("") === null, "empty duration null");

const html =
  '<div data-gtm-duration="13-NIGHT CRUISE" data-gtm-package-code="JR270707-013" data-gtm-ship-name="Azamara Journey"></div>';
const gtm = extractAzamaraGtmFromHtml(html);
assert(gtm.nights === 13, "html gtm nights");
assert(gtm.package_code === "JR270707-013", "html gtm package");

const enriched = enrichStructuredVoyageFromHtml(null, html, "https://www.azamara.com/cruises/jr270707-013");
assert(enriched.nights === 13, "structured voyage nights from gtm");

function addDaysIso(isoDate, days) {
  const [y, m, d] = String(isoDate).slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + Number(days));
  return dt.toISOString().slice(0, 10);
}

const dep = "2027-07-07";
const ret = addDaysIso(dep, 13);
assert(ret === "2027-07-20", "return date departure + nights");

assert(
  validateAzamaraOceanDuration({ departure_date: dep, nights: 13, return_date: ret }).length === 0,
  "valid duration passes"
);
assert(
  validateAzamaraOceanDuration({ departure_date: dep, nights: null, return_date: null }).includes(
    "Azamara cruise duration missing or invalid"
  ),
  "missing duration fails"
);
assert(
  validateAzamaraOceanDuration({ departure_date: dep, nights: 13, return_date: null }).includes(
    "Azamara return date could not be established"
  ),
  "missing return fails"
);

const skipCta = azamaraPreBuildGate({
  cruiseLine: azamaraLine,
  url: "https://www.azamara.com/cruises/pr270705-014-cta01-test",
  title: "ALASKA EXPLORER CRUISETOUR",
  description: "Post-cruise land programme",
  structuredVoyage: { package_code: "PR270705-014-CTA01" }
});
assert(skipCta?.reason === "policy_excluded_cruisetour", "pre-build gate excludes CTA");

const ships = [{ id: "ship-1", name: "Pursuit" }];
const destinations = [
  { id: "japan-id", name: "Japan", slug: "japan" },
  { id: "africa-id", name: "Africa", slug: "africa" }
];
const builtOcean = buildCandidateFromSource({
  title: "JAPAN INTENSIVE CRUISE: TOKYO, KOBE & NAGASAKI",
  description: "Explore this Japan Intensive Cruise",
  url: "https://www.azamara.com/cruises/pr261002-014-japan-intensive",
  excerpt: "Destination: AFRICA",
  cruiseLine: azamaraLine,
  ships,
  destinations,
  shipAliases: [{ alias: "Azamara Pursuit", ship_id: "ship-1" }],
  destinationAliases: [],
  structuredVoyage: {
    ship_name: "Azamara Pursuit",
    departure_date: "2026-10-02",
    nights: 14,
    package_code: "PR261002-014",
    source: "azamara_gtm"
  },
  html: '<div data-gtm-duration="14-NIGHT CRUISE"></div>'
});
assert(!builtOcean.skip, "ocean candidate not skipped");
assert(builtOcean.candidate.nights === 14, "ocean candidate nights populated");
assert(builtOcean.candidate.return_date === "2026-10-16", "ocean candidate return derived");

const destHits = matchDestination(
  "Destination: AFRICA\nJAPAN INTENSIVE CRUISE: TOKYO, KOBE & NAGASAKI",
  destinations,
  []
);
const picked = pickDestinationFromHits(destHits, "JAPAN INTENSIVE CRUISE: TOKYO, KOBE & NAGASAKI");
assert(picked?.name === "Japan", "Japan still wins over Africa token");

const builtCta = buildCandidateFromSource({
  title: "ALASKA EXPLORER CRUISETOUR",
  description: "Post-cruise land programme",
  url: "https://www.azamara.com/cruises/pr270705-014-cta01-test",
  excerpt: "",
  cruiseLine: azamaraLine,
  ships,
  destinations,
  shipAliases: [{ alias: "Azamara Pursuit", ship_id: "ship-1" }],
  destinationAliases: [],
  structuredVoyage: { package_code: "PR270705-014-CTA01", nights: 10 }
});
assert(builtCta.skip && builtCta.reason === "policy_excluded_cruisetour", "build skips cruisetour");

console.log("test:azamara-discovery — all assertions passed");
