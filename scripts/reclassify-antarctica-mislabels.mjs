#!/usr/bin/env node
/**
 * Reclassify discovered_cruises wrongly tagged Antarctica (HAL broad label bug).
 *
 *   node scripts/reclassify-antarctica-mislabels.mjs --dry-run
 *   node scripts/reclassify-antarctica-mislabels.mjs --apply
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const hal = require(path.join(root, "netlify/functions/lib/holland-america-discovery-adapter"));
const {
  resolveOperationalDestination,
  hasAntarcticaRouteEvidence
} = require(path.join(root, "netlify/functions/lib/discovery-destination-resolver"));

const HAL_HEADERS = {
  Accept: "application/json",
  "User-Agent": "101cruise-discovery/1.0 (+https://101cruise.com.au)"
};

function parseArgs(argv) {
  return { dryRun: !argv.includes("--apply"), apply: argv.includes("--apply") };
}

async function fetchHalRaw(cruiseId) {
  const needle = encodeURIComponent(String(cruiseId || "").trim());
  const url = `https://www.hollandamerica.com/search/halcruisesearch?q=${needle}&size=5`;
  const response = await fetch(url, { headers: HAL_HEADERS });
  if (!response.ok) return null;
  const data = await response.json();
  const docs = data?.response?.docs || [];
  const doc = docs.find((d) => String(d.cruiseId || "").toUpperCase() === String(cruiseId).toUpperCase());
  return doc ? hal.parseRawVoyageFromDoc(doc) : null;
}

function reassessSlug(row, halRaw, destinations) {
  const raw = row.raw_extract || {};
  const title = halRaw?.title || raw.title || "";
  const description = halRaw?.description || raw.description || "";
  const itinerary = halRaw?.itinerary_text || row.itinerary || "";

  if (hasAntarcticaRouteEvidence({ title, description, itinerary, departurePort: row.departure_port })) {
    return "antarctica";
  }

  let preferredDestination = null;
  if (halRaw) {
    const hints = hal.resolveHalDestinationHints(halRaw);
    if (hints.preferredSlug) preferredDestination = { slug: hints.preferredSlug };
  }

  const result = resolveOperationalDestination({
    title,
    description,
    itinerary,
    departurePort: row.departure_port,
    destinations,
    preferredDestination
  });

  if (result.status === "resolved" && result.destinationKey) {
    return result.destinationKey;
  }

  if (/\bpanama canal\b/i.test([title, itinerary].join(" "))) return "panama-canal";
  if (/\bamazon\b/i.test([title, itinerary].join(" "))) return "south-america";
  if (
    /\b(trinidad|barbados|brazil|rio de janeiro|buenos aires|valparaiso|chile|argentina|georgetown|cayman)\b/i.test(
      itinerary
    )
  ) {
    return "south-america";
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createSupabaseRest(root);

  const antarcticaRows = await sb.get(
    "destinations?slug=eq.antarctica&select=id,slug&limit=1"
  );
  const antarcticaId = antarcticaRows?.[0]?.id;
  if (!antarcticaId) throw new Error("Antarctica destination not found");

  const destinationRows = await sb.get("destinations?select=id,slug,name,status,classification_enabled");
  const destinations = (destinationRows || []).map((d) => ({
    id: d.id,
    name: d.name,
    slug: d.slug,
    status: d.status,
    classification_enabled: d.classification_enabled !== false
  }));
  const destinationIdBySlug = Object.fromEntries(destinations.map((d) => [d.slug, d.id]));

  const rows = await sb.fetchAll(
    `discovered_cruises?destination_id=eq.${encodeURIComponent(antarcticaId)}&status=eq.active&select=id,departure_date,departure_port,itinerary,raw_extract,cruise_line_id`
  );

  const changes = [];
  for (const row of rows) {
    const raw = row.raw_extract || {};
    let halRaw = null;
    if (raw.hal_cruise_id) {
      halRaw = await fetchHalRaw(raw.hal_cruise_id);
    }
    const nextSlug = reassessSlug(row, halRaw, destinations);
    const nextDestinationId = nextSlug ? destinationIdBySlug[nextSlug] : null;
    if (!nextSlug || nextSlug === "antarctica" || !nextDestinationId) continue;
    changes.push({
      id: row.id,
      departure_date: row.departure_date,
      title: raw.title || "",
      from: "antarctica",
      to: nextSlug,
      nextDestinationId,
      raw_extract: raw
    });
  }

  console.log(
    JSON.stringify(
      {
        mode: args.apply ? "apply" : "dry-run",
        scanned: rows.length,
        changes: changes.length,
        by_destination: changes.reduce((acc, c) => {
          acc[c.to] = (acc[c.to] || 0) + 1;
          return acc;
        }, {})
      },
      null,
      2
    )
  );

  for (const change of changes) {
    console.log(`- ${change.departure_date} ${change.title.slice(0, 55)} → ${change.to}`);
  }

  if (!args.apply) {
    console.log("Dry run only. Re-run with --apply to write changes.");
    return;
  }

  for (const change of changes) {
    await sb.patch(`discovered_cruises?id=eq.${encodeURIComponent(change.id)}`, {
      destination_id: change.nextDestinationId,
      raw_extract: {
        ...change.raw_extract,
        destination_key: change.to,
        destination_reclassified_at: new Date().toISOString(),
        destination_reclassified_from: "antarctica",
        destination_reclassified_reason: "hal_south_america_antarctica_label_without_route"
      },
      last_changed_at: new Date().toISOString()
    });
  }

  console.log(`Applied ${changes.length} destination corrections.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
