/**
 * Offline checks for Client Portal cruise-ship resolution.
 * Run: node scripts/test-resolve-cruise-ship.mjs
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);

const {
  expandTerminalNumeralVariants,
  expandLineAwareNameVariants,
  resolveCruiseLineAlias,
  canonicalCruiseLineDisplayName,
  resolveCruiseShip,
  filterSupabaseByLine,
  normaliseText
} = require("../netlify/functions/lib/resolve-cruise-ship.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const ships = [
  { id: "e1", name: "EXPLORA I", cruise_line_name: "Explora Journeys" },
  { id: "e2", name: "EXPLORA II", cruise_line_name: "Explora Journeys" },
  { id: "e3", name: "EXPLORA III", cruise_line_name: "Explora Journeys" },
  { id: "m1", name: "Millennium", cruise_line_name: "Celebrity Cruises", hero_image_url: "https://cdn.example/millennium.jpg" },
  { id: "cm1", name: "Celebrity Millennium", cruise_line_name: "Celebrity Cruises", hero_image_url: "https://cdn.example/celebrity-millennium.jpg" },
  {
    id: "sp1",
    name: "Sapphire Princess",
    cruise_line_name: "Princess Cruises",
    hero_image_url: "https://cdn.example/sapphire-princess.jpg"
  },
  {
    id: "gp1",
    name: "Grand Princess",
    cruise_line_name: "Princess Cruises",
    hero_image_url: "https://cdn.example/grand-princess.jpg"
  },
  {
    id: "ns1",
    name: "Norwegian Star",
    cruise_line_name: "Norwegian Cruise Line",
    hero_image_url: "https://cdn.example/norwegian-star.jpg"
  },
  { id: "rs1", name: "Star Princess", cruise_line_name: "Princess Cruises" },
  { id: "q1", name: "Queen Elizabeth", cruise_line_name: "Cunard" },
  { id: "r1", name: "Symphony of the Seas", cruise_line_name: "Royal Caribbean International" }
];

assert(
  expandTerminalNumeralVariants("Explora 1").includes("explora i"),
  "Explora 1 expands to roman I"
);
assert(
  expandTerminalNumeralVariants("EXPLORA I").includes("explora 1"),
  "EXPLORA I expands to arabic 1"
);
assert(
  expandTerminalNumeralVariants("Explora 2").includes("explora ii"),
  "Explora 2 ↔ II"
);
assert(
  expandTerminalNumeralVariants("Explora 3").includes("explora iii"),
  "Explora 3 ↔ III"
);
assert(
  !expandTerminalNumeralVariants("Queen Elizabeth").includes("queen elizabeth 1"),
  "terminal numeral conversion does not invent numerals"
);
assert(
  expandTerminalNumeralVariants("Queen Elizabeth").length === 1,
  "Queen Elizabeth stays a single variant"
);

assert(
  resolveCruiseLineAlias("Explora Cruises") === "explora journeys",
  "Explora Cruises aliases to Explora Journeys"
);
assert(
  canonicalCruiseLineDisplayName("Explora Cruises") === "Explora Journeys",
  "display canonicalises Explora Cruises"
);
assert(
  canonicalCruiseLineDisplayName("Explora Journeys") === "Explora Journeys",
  "canonical Explora Journeys unchanged"
);
assert(
  resolveCruiseLineAlias("Celebrity Cruises") === "celebrity cruises",
  "unrelated lines are not aliased"
);
assert(
  expandLineAwareNameVariants("Sapphire", "Princess Cruises").includes("sapphire princess"),
  "Princess suffix variant"
);

const explora1 = resolveCruiseShip(ships, "Explora 1", "Explora Cruises");
assert(explora1.status === "matched" && explora1.ship.name === "EXPLORA I", "Explora 1 → EXPLORA I");

const explora2 = resolveCruiseShip(ships, "Explora 2", "Explora Cruises");
assert(explora2.status === "matched" && explora2.ship.name === "EXPLORA II", "Explora 2 → EXPLORA II");

const explora3 = resolveCruiseShip(ships, "Explora 3", "Explora Journeys");
assert(explora3.status === "matched" && explora3.ship.name === "EXPLORA III", "Explora 3 → EXPLORA III");

const romanCanonical = resolveCruiseShip(ships, "EXPLORA I", "Explora Journeys");
assert(
  romanCanonical.status === "matched" && romanCanonical.ship.name === "EXPLORA I",
  "Roman numeral canonical names remain unchanged"
);

const millennium = resolveCruiseShip(ships, "Millennium", "Celebrity");
assert(millennium.status === "matched" && millennium.ship.id === "m1", "Celebrity Millennium still resolves");

const celebrityMillennium = resolveCruiseShip(
  ships.filter((s) => s.id !== "m1"),
  "Millennium",
  "Celebrity Cruises"
);
assert(
  celebrityMillennium.status === "matched" && celebrityMillennium.ship.name === "Celebrity Millennium",
  "Millennium + Celebrity Cruises → Celebrity Millennium"
);
assert(
  celebrityMillennium.ship.hero_image_url.includes("celebrity-millennium"),
  "Celebrity Millennium default hero returned"
);

const sapphire = resolveCruiseShip(ships, "Sapphire", "Princess Cruises");
assert(sapphire.status === "matched" && sapphire.ship.name === "Sapphire Princess", "Sapphire + Princess → Sapphire Princess");
assert(
  sapphire.ship.hero_image_url === "https://cdn.example/sapphire-princess.jpg",
  "Sapphire Princess default hero returned"
);

const grand = resolveCruiseShip(ships, "Grand", "Princess Cruises");
assert(grand.status === "matched" && grand.ship.name === "Grand Princess", "Grand + Princess → Grand Princess");

const norwegianStar = resolveCruiseShip(ships, "Star", "Norwegian Cruise Lines");
assert(
  norwegianStar.status === "matched" && norwegianStar.ship.name === "Norwegian Star",
  "Star + Norwegian Cruise Lines → Norwegian Star"
);

const starNoLine = resolveCruiseShip(ships, "Star", "");
assert(starNoLine.status === "not_found" || starNoLine.status === "ambiguous", "Star without cruise line is not guessed");

const starPrincess = resolveCruiseShip(ships, "Star", "Princess Cruises");
assert(
  starPrincess.status === "matched" && starPrincess.ship.name === "Star Princess",
  "Star + Princess Cruises → Star Princess (line-scoped)"
);

const scoped = filterSupabaseByLine(ships, "Explora Cruises");
assert(
  scoped.every((s) => normaliseText(s.cruise_line_name).includes("explora")),
  "strict cruise-line ownership remains enforced after alias"
);

const ambiguous = resolveCruiseShip(
  [
    { id: "a", name: "Explorer", cruise_line_name: "Line A" },
    { id: "b", name: "Explorer", cruise_line_name: "Line B" }
  ],
  "Explorer",
  ""
);
assert(ambiguous.status === "ambiguous", "ambiguous matches fail safely");

const ambiguousSameLine = resolveCruiseShip(
  [
    { id: "a", name: "Sapphire Dream", cruise_line_name: "Princess Cruises" },
    { id: "b", name: "Sapphire Jewel", cruise_line_name: "Princess Cruises" }
  ],
  "Sapphire",
  "Princess Cruises"
);
assert(ambiguousSameLine.status === "ambiguous", "ambiguous same-line candidates return no hero");

const missing = resolveCruiseShip(ships, "Does Not Exist", "Explora Cruises");
assert(missing.status === "not_found", "unknown ships fail safely");

console.log("test-resolve-cruise-ship: ok");
