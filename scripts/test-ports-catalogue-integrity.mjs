#!/usr/bin/env node
import assert from "assert";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const {
  findDuplicateCanonicalPorts,
  isSuspiciousCanonicalPortName,
  assertCanonicalPortNameAllowed,
  assertChanMayCoordinates
} = require(path.join(root, "scripts/lib/port-canonical-integrity.cjs"));

assert.throws(() => assertCanonicalPortNameAllowed("April 2028"), /year_or_date/);
assert.throws(() => assertCanonicalPortNameAllowed("At Sea"), /itinerary_label/);
assert.doesNotThrow(() => assertCanonicalPortNameAllowed("Sydney"));
assert.doesNotThrow(() => assertCanonicalPortNameAllowed("Port Chalmers"));

const dupes = findDuplicateCanonicalPorts([
  { id: "1", canonical_name: "Miami", country: "Florida", match_key: "miami|florida" },
  { id: "2", canonical_name: "Miami", country: "United States", match_key: "miami|united states" }
]);
assert.equal(dupes.length, 1, "same canonical name different country flagged");

const legit = findDuplicateCanonicalPorts([
  { id: "1", canonical_name: "Sydney", country: "Australia", match_key: "sydney|australia" },
  { id: "2", canonical_name: "Sydney Nova Scotia", country: "Canada", match_key: "sydney nova scotia|canada" }
]);
assert.equal(legit.length, 0, "legitimate same-name ports in different countries are not duplicates");

assert.equal(isSuspiciousCanonicalPortName("April 2028").reason, "year_or_date");

const { indexPortsCatalogue, lookupCataloguePort, hasValidPortImage } = require(path.join(
  root,
  "netlify/functions/lib/port-image-finder/resolve-public.js"
));

const physicalPorts = [
  { canonical_name: "Seville", country: "Spain", hero_media_id: "media-seville", image_status: "AUTO_APPROVED" },
  { canonical_name: "Cadiz", country: "Spain", aliases: [], hero_media_id: "media-cadiz", image_status: "AUTO_APPROVED" },
  { canonical_name: "Bangkok Port", country: "Thailand", hero_media_id: "media-bkk", image_status: "AUTO_APPROVED" },
  {
    canonical_name: "Laem Chabang",
    country: "Thailand",
    aliases: [],
    display_name: "Laem Chabang (Bangkok), Thailand",
    hero_media_id: "media-lcb",
    image_status: "AUTO_APPROVED"
  },
  { canonical_name: "Chan May", country: "Vietnam", display_name: "Chan May (Hue), Vietnam", latitude: 16.333444, longitude: 108.013667, aliases: ["Chan May Port"], hero_media_id: "media-cm", image_status: "AUTO_APPROVED" },
  { canonical_name: "Da Nang", country: "Vietnam", aliases: ["Danang"], hero_media_id: "media-dn", image_status: "AUTO_APPROVED" },
  { canonical_name: "Tokyo", country: "Japan", aliases: ["Tokyo International Cruise Terminal"], hero_media_id: "media-tokyo", image_status: "AUTO_APPROVED" },
  { canonical_name: "Yokohama", country: "Japan", display_name: "Yokohama (Tokyo), Japan", aliases: [], hero_media_id: "media-yoko", image_status: "AUTO_APPROVED" },
  { canonical_name: "Port Chalmers", country: "New Zealand", display_name: "Port Chalmers (Dunedin), New Zealand", aliases: [], hero_media_id: "media-pc", image_status: "AUTO_APPROVED" },
  { canonical_name: "Saint John", country: "Canada", aliases: ["St John NB"], hero_media_id: "media-sj-nb", image_status: "MANUAL" },
  { canonical_name: "St Johns Newfoundland", country: "Canada", display_name: "St John's, Newfoundland", city: "St John's", aliases: ["Newfoundland", "St Johns"], hero_media_id: "media-sj-nl", image_status: "MANUAL" },
  { canonical_name: "St Johns Antigua", country: "Antigua and Barbuda", display_name: "St John's, Antigua", city: "St John's", aliases: ["Antigua", "St Johns"], hero_media_id: "media-sj-ag", image_status: "AUTO_APPROVED" },
  { canonical_name: "Miami", country: "United States", region: "Florida", aliases: [], hero_media_id: "media-miami", image_status: "AUTO_APPROVED" },
  { canonical_name: "Phu My", country: "Vietnam", aliases: ["Ho Chi Minh City"], hero_media_id: "media-pm", image_status: "AUTO_APPROVED" },
  { canonical_name: "Tokyo", country: "Japan", hero_media_id: "media-tokyo", image_status: "AUTO_APPROVED" },
  { canonical_name: "Yokohama", country: "Japan", aliases: [], hero_media_id: "media-yoko", image_status: "AUTO_APPROVED" },
  { canonical_name: "Osaka", country: "Japan", hero_media_id: "media-osaka", image_status: "AUTO_APPROVED" },
  { canonical_name: "Kobe", country: "Japan", aliases: ["Kyoto"], hero_media_id: "media-kobe", image_status: "AUTO_APPROVED" },
  { canonical_name: "Los Angeles", country: "United States", aliases: ["San Pedro"], hero_media_id: "media-la", image_status: "AUTO_APPROVED" },
  { canonical_name: "Long Beach", country: "United States", aliases: [], hero_media_id: "media-lb", image_status: "AUTO_APPROVED" },
  { canonical_name: "George Town", country: "Cayman Islands", hero_media_id: "media-gtc", image_status: "AUTO_APPROVED" },
  { canonical_name: "Penang", country: "Malaysia", aliases: [], hero_media_id: "media-pen", image_status: "AUTO_APPROVED" }
];
const idx = indexPortsCatalogue(physicalPorts);
const checks = [
  ["Seville", "Seville"],
  ["Cadiz", "Cadiz"],
  ["Bangkok Port", "Bangkok Port"],
  ["Laem Chabang", "Laem Chabang"],
  ["Chan May", "Chan May"],
  ["Chan May Port", "Chan May"],
  ["Da Nang", "Da Nang"],
  ["Danang", "Da Nang"],
  ["Tokyo", "Tokyo"],
  ["Yokohama", "Yokohama"],
  ["Tokyo / Yokohama", "Yokohama"],
  ["Dunedin / Port Chalmers", "Port Chalmers"],
  ["Saint John", "Saint John"],
  ["St John's", null],
  ["St John's, Antigua", "St Johns Antigua"],
  ["St Johns Newfoundland", "St Johns Newfoundland"],
  ["Miami", "Miami"],
  ["Ho Chi Minh City", "Phu My"],
  ["Tokyo", "Tokyo"],
  ["Yokohama", "Yokohama"],
  ["Osaka", "Osaka"],
  ["Long Beach", "Long Beach"],
  ["George Town", "George Town"]
];
for (const [query, expected] of checks) {
  const hit = lookupCataloguePort(query, idx, physicalPorts.filter(hasValidPortImage));
  if (expected === null) {
    assert.equal(hit, null, `${query} must not resolve without sufficient context`);
  } else {
    assert.equal(hit?.canonical_name, expected, `${query} resolves to ${expected}`);
  }
}

for (const badQuery of ["Hue", "Hoi An", "Bangkok"]) {
  const hit = lookupCataloguePort(badQuery, idx, physicalPorts.filter(hasValidPortImage));
  assert.equal(hit, null, `${badQuery} must not resolve via display_name destination wording or cross-port alias`);
}

assertChanMayCoordinates(16.333444, 108.013667);
assert.throws(
  () => assertChanMayCoordinates(16.267, 111.324),
  /outside expected Chân Mây port area/
);

console.log("test-ports-catalogue-integrity: ok");
