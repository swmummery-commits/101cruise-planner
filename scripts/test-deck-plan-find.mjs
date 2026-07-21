/**
 * Lightweight offline checks for Sprint 12A deck-plan finder rules.
 * Run: node scripts/test-deck-plan-find.mjs
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);

const {
  isBlockedDomain,
  sameSiteOrSubdomain,
  classifySourceType,
  selectStrongestCandidates,
  MAX_CANDIDATES,
  MIN_CANDIDATE_SCORE
} = require("../netlify/functions/lib/deck-plan-find.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(isBlockedDomain("www.cruisecritic.com"), "block Cruise Critic");
assert(isBlockedDomain("cruisemapper.com"), "block CruiseMapper");
assert(!isBlockedDomain("princess.com"), "allow Princess");
assert(sameSiteOrSubdomain("www.virginvoyages.com", "virginvoyages.com"), "VV subdomain");
assert(!sameSiteOrSubdomain("cruisecritic.com", "celebritycruises.com"), "reject cross domain");

assert(classifySourceType("https://example.com/deck-plans.pdf") === "official_pdf", "pdf type");
assert(
  classifySourceType("https://example.com/ships/ship/interactive-deck-plan", "Interactive") ===
    "official_interactive_viewer",
  "interactive type"
);

const many = [];
for (let i = 0; i < 20; i++) {
  many.push({
    url: `https://princess.com/deck-plans/${i}`,
    title: `Deck ${i}`,
    reason: "Found on the official ship page",
    score: 30 + i,
    id: `t:${i}`
  });
}
const selected = selectStrongestCandidates(many);
assert(selected.length <= MAX_CANDIDATES, "cap candidates");
assert(selected.every((c) => c.score >= MIN_CANDIDATE_SCORE || selected.length === 1), "strong only");
assert(selected[0].score >= selected[selected.length - 1].score, "sorted strong first");

console.log("deck-plan-find offline checks passed");
console.log({
  MAX_CANDIDATES,
  MIN_CANDIDATE_SCORE,
  selected: selected.map((c) => ({ score: c.score, type: c.source_type }))
});
