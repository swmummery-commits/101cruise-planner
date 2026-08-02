#!/usr/bin/env node
/**
 * Dry-run Discovery automation against current pending review queue.
 * READ-ONLY — performs no Supabase writes.
 *
 *   node scripts/simulate-discovery-automation.mjs
 *   node scripts/simulate-discovery-automation.mjs --snapshot=/path/to/snapshot.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { simulateQueueAutomation, ACTION, SUBTYPE } = require(
  path.join(root, "netlify/functions/lib/discovery-auto-resolver.js")
);
const { loadPortsCatalogue } = require(path.join(root, "netlify/functions/lib/discovery-departure-port.js"));

function parseArgs(argv) {
  const args = { snapshot: null, fetch: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--snapshot=")) args.snapshot = arg.slice("--snapshot=".length);
    if (arg === "--fetch") args.fetch = true;
  }
  return args;
}

async function loadLiveSnapshot(sb) {
  const items = await sb.get(
    "cruise_discovery_review_items?status=eq.pending&select=*&order=created_at.asc&limit=5000"
  );
  const lineIds = [...new Set(items.map((i) => i.cruise_line_id).filter(Boolean))];
  const lines = lineIds.length
    ? await sb.get(
        `ci_cruise_lines?id=in.(${lineIds.map((id) => encodeURIComponent(id)).join(",")})&select=id,name,slug,website_url,cruise_search_url`
      )
    : [];
  const ships = await sb.get(
    "ci_cruise_ships?active=eq.true&select=id,name,slug,cruise_line_id,official_ship_url&limit=5000"
  );
  const aliases = await sb.get("cruise_ship_aliases?active=eq.true&select=*&limit=5000");
  const destinations = await sb.get("destinations?select=id,name,slug,primary_region,status&limit=500");
  const destAliases = await sb.get("cruise_destination_aliases?active=eq.true&select=*&limit=5000").catch(() => []);
  const cruises = await sb.get(
    "discovered_cruises?status=neq.hidden&select=id,external_key,status,cruise_line_id,ship_id,destination_id,departure_date,departure_port,itinerary,official_url,raw_extract&limit=5000"
  );
  return { items, lines, ships, aliases, destinations, destAliases, cruises };
}

function buildContext(snapshot) {
  const linesById = Object.fromEntries((snapshot.lines || []).map((l) => [l.id, l]));
  const lineNameById = Object.fromEntries((snapshot.lines || []).map((l) => [l.id, l.name]));
  const cruisesByKey = Object.fromEntries((snapshot.cruises || []).map((c) => [c.external_key, c]));
  return {
    linesById,
    lineNameById,
    ships: snapshot.ships || [],
    aliases: snapshot.aliases || [],
    destinations: snapshot.destinations || [],
    destinationAliases: snapshot.destAliases || [],
    cruisesByKey,
    ports: loadPortsCatalogue()
  };
}

function legacyNonSailingManifest(results) {
  return results
    .filter((r) => r.proposed_action === ACTION.AUTO_REJECT && r.reasons?.some((x) => x.startsWith("non_sailing")))
    .map((r) => ({
      review_item_id: r.review_item_id,
      discovered_cruise_id: r.discovered_cruise_id,
      url: r.source_url,
      title: r.source_title,
      rejection_reason: r.reasons.find((x) => x.startsWith("non_sailing")) || r.reasons[0],
      before_status: "pending",
      proposed_status: "ignored",
      proposed_cruise_status: "hidden",
      rollback: { review_status: "pending", cruise_status: "match_required" }
    }));
}

async function main() {
  const args = parseArgs(process.argv);
  let snapshot;
  if (args.snapshot && fs.existsSync(args.snapshot)) {
    snapshot = JSON.parse(fs.readFileSync(args.snapshot, "utf8"));
  } else if (args.fetch || fs.existsSync("/tmp/review-queue-full.json")) {
    if (args.fetch) {
      const sb = createSupabaseRest(root);
      snapshot = await loadLiveSnapshot(sb);
    } else {
      snapshot = JSON.parse(fs.readFileSync("/tmp/review-queue-full.json", "utf8"));
      if (!snapshot.lines?.length) {
        const sb = createSupabaseRest(root);
        const live = await loadLiveSnapshot(sb);
        snapshot.lines = live.lines;
        snapshot.destAliases = live.destAliases;
      }
    }
  } else {
    const sb = createSupabaseRest(root);
    snapshot = await loadLiveSnapshot(sb);
  }

  const context = buildContext(snapshot);
  const { results, summary } = simulateQueueAutomation(snapshot.items || [], context);

  const legacyManifest = legacyNonSailingManifest(results);

  const report = {
    generated_at: new Date().toISOString(),
    mode: "dry-run",
    writes_performed: false,
    queue_total: summary.total,
    summary,
    action_labels: ACTION,
    subtype_labels: SUBTYPE,
    legacy_non_sailing_cleanup_manifest: legacyManifest,
    items: results
  };

  const reportsDir = path.join(root, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportsDir, `discovery-automation-dry-run-${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log("Discovery automation dry-run (NO WRITES)");
  console.log(`Queue items: ${summary.total}`);
  console.log(`Auto-publish: ${summary.auto_publish}`);
  console.log(`Auto-resolve: ${summary.auto_resolve}`);
  console.log(`Auto-reject: ${summary.auto_reject}`);
  console.log(`Ship maintenance (deduped): ${summary.unique_ship_maintenance} unique / ${summary.ship_maintenance} findings`);
  console.log(`Line configuration: ${summary.line_config}`);
  console.log(`Close obsolete: ${summary.close_obsolete}`);
  console.log(`Human review remaining: ${summary.human_review}`);
  console.log(`Alias proposals (would create): ${summary.alias_proposals}`);
  console.log("Subtypes:", summary.by_subtype);
  console.log(`Legacy non-sailing manifest: ${legacyManifest.length} items`);
  console.log(`Report: ${reportPath}`);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
