#!/usr/bin/env node
/**
 * Seed featured destination_ports for Cruise Finder Living Destination pages.
 *
 *   node scripts/seed-cruise-finder-featured-ports.mjs --dry-run
 *   node scripts/seed-cruise-finder-featured-ports.mjs --apply
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import {
  CRUISE_FINDER_DESTINATION_SLUGS,
  CRUISE_FINDER_FEATURED_PORTS
} from "./data/cruise-finder-featured-ports.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

function parseArgs(argv) {
  return { apply: argv.includes("--apply"), dryRun: !argv.includes("--apply") };
}

async function loadExistingPorts(sb, destinationIds) {
  if (!destinationIds.length) return new Map();
  const inList = destinationIds.map((id) => encodeURIComponent(id)).join(",");
  const rows = await sb.get(
    `destination_ports?destination_id=in.(${inList})&select=destination_id,slug,name&order=display_order.asc`
  );
  const byDest = new Map();
  for (const row of rows || []) {
    if (!byDest.has(row.destination_id)) byDest.set(row.destination_id, new Set());
    byDest.get(row.destination_id).add(String(row.slug || "").toLowerCase());
  }
  return byDest;
}

async function main() {
  const { dryRun } = parseArgs(process.argv);
  const sb = createSupabaseRest(root);
  const slugs = CRUISE_FINDER_DESTINATION_SLUGS.map(encodeURIComponent).join(",");
  const destinations = await sb.get(
    `destinations?slug=in.(${slugs})&select=id,slug,name,status&order=slug.asc`
  );
  const destBySlug = Object.fromEntries((destinations || []).map((d) => [d.slug, d]));
  const missingDestinations = CRUISE_FINDER_DESTINATION_SLUGS.filter((slug) => !destBySlug[slug]);
  if (missingDestinations.length) {
    throw new Error(`Missing destination shells: ${missingDestinations.join(", ")}`);
  }

  const existingByDest = await loadExistingPorts(
    sb,
    destinations.map((d) => d.id)
  );

  const summary = { inserted: 0, skipped: 0, byDestination: {} };

  for (const slug of CRUISE_FINDER_DESTINATION_SLUGS) {
    const dest = destBySlug[slug];
    const ports = CRUISE_FINDER_FEATURED_PORTS[slug] || [];
    const existingSlugs = existingByDest.get(dest.id) || new Set();
    const toInsert = ports.filter((port) => !existingSlugs.has(String(port.slug).toLowerCase()));
    summary.byDestination[slug] = { existing: existingSlugs.size, insert: toInsert.length };

    for (const port of toInsert) {
      const row = {
        destination_id: dest.id,
        name: port.name,
        slug: port.slug,
        short_description: port.short_description,
        display_order: port.display_order,
        active: true
      };
      if (dryRun) {
        console.log(`  [dry-run] ${slug}: would insert ${port.slug}`);
      } else {
        await sb.post("destination_ports", row, { prefer: "return=minimal" });
        console.log(`  inserted ${slug}/${port.slug}`);
      }
      summary.inserted += 1;
    }
    summary.skipped += ports.length - toInsert.length;
  }

  console.log("\nSummary:");
  console.log(`  mode: ${dryRun ? "dry-run" : "apply"}`);
  console.log(`  ports to insert: ${summary.inserted}`);
  console.log(`  ports already present: ${summary.skipped}`);
  for (const [slug, counts] of Object.entries(summary.byDestination)) {
    console.log(`  ${slug}: ${counts.existing} existing, ${counts.insert} new`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
