/**
 * Offline checks for Client Portal cruise-ship resolution.
 * Run: node scripts/test-resolve-cruise-ship.mjs
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);

const {
  expandTerminalNumeralVariants,
  resolveCruiseLineAlias,
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
  { id: "m1", name: "Millennium", cruise_line_name: "Celebrity Cruises" },
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
  resolveCruiseLineAlias("Celebrity Cruises") === "celebrity cruises",
  "unrelated lines are not aliased"
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

const missing = resolveCruiseShip(ships, "Does Not Exist", "Explora Cruises");
assert(missing.status === "not_found", "unknown ships fail safely");

console.log("test-resolve-cruise-ship: ok");
