#!/usr/bin/env node
/**
 * Verify five new catalogue ports + La Spezia regression (discovery only).
 *
 *   node scripts/batch-port-image-verify-five.mjs
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { findPortImageCandidates } = require(path.join(root, "netlify/functions/lib/port-image-finder/search.js"));
const {
  scorePortImageCandidate,
  statusForCandidate,
  pickBestCandidate,
  classifyImageAge,
  isMilitaryWarDestinationImagery,
  licenseIsUsable
} = require(path.join(root, "netlify/functions/lib/port-image-finder/scoring.js"));

const PORT_SELECT =
  "id,canonical_name,display_name,city,country,country_code,region,aliases,hero_media_id,image_status";

const SPECS = [
  { label: "Busan, South Korea", match: /busan|pusan/i, country: /south korea|korea/i },
  { label: "Kagoshima, Japan", match: /kagoshima/i, country: /japan/i },
  { label: "Cozumel, Mexico", match: /cozumel/i, country: /mexico/i },
  { label: "George Town, Grand Cayman", match: /george town|grand cayman|cayman/i, country: /cayman/i, exclude: /malaysia|penang/i },
  { label: "Santorini, Greece", match: /santorini|thira|fira|oia/i, country: /greece/i },
  { label: "La Spezia, Italy", match: /la spezia|spezia/i, country: /italy/i, exclude: /naples|napoli/i }
];

function portHaystack(port) {
  return [port.canonical_name, port.display_name, port.city, port.country, port.region, ...(port.aliases || [])]
    .filter(Boolean)
    .join(" ");
}

function findCataloguePort(allPorts, spec) {
  return allPorts.find((port) => {
    const hay = portHaystack(port);
    if (spec.exclude && spec.exclude.test(hay)) return false;
    if (!spec.country.test(hay)) return false;
    const canonical = String(port.canonical_name || "");
    const city = String(port.city || "");
    return spec.match.test(canonical) || spec.match.test(city);
  });
}

async function discoverPort(port) {
  const search = await findPortImageCandidates(port, { force: true, autoApply: false });
  const pickCandidate = search.eligibleCandidate || null;
  const rawTopCandidate = search.rawTopCandidate || search.candidates?.[0] || null;
  const pick = pickCandidate
    ? {
        candidate: pickCandidate,
        ...scorePortImageCandidate(pickCandidate, port)
      }
    : null;
  const age = pick ? classifyImageAge(pick.candidate) : null;
  return {
    port,
    search,
    rawTop: rawTopCandidate?.title || null,
    rawTopMilitary: rawTopCandidate ? isMilitaryWarDestinationImagery(rawTopCandidate) : false,
    selected: pick?.candidate?.title || null,
    selectedRank: search.selectedRank,
    displacedHistorical: search.displacedHistorical,
    provider: pick?.candidate?.provider || null,
    license: pick?.candidate?.license || null,
    geographic: pick?.geographic || null,
    suitability: pick?.suitability || null,
    status: pick ? statusForCandidate(pick) : "NO_IMAGE",
    ageClass: age?.ageClass || null,
    licensed: pick ? licenseIsUsable(pick.candidate) : null
  };
}

async function main() {
  const rest = createSupabaseRest(root);
  const allPorts = await rest.get(`ports?select=${encodeURIComponent(PORT_SELECT)}&limit=2000`);
  const results = [];

  for (const spec of SPECS) {
    const port = findCataloguePort(allPorts, spec);
    if (!port) {
      results.push({ label: spec.label, found: false });
      continue;
    }
    results.push({ label: spec.label, found: true, catalogue: port.canonical_name, ...(await discoverPort(port)) });
  }

  console.log(JSON.stringify({ phase: "verify_five_plus_la_spezia", results }, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
