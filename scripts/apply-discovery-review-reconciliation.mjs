#!/usr/bin/env node
/**
 * Generate and apply Discovery review queue reconciliation.
 *
 *   node scripts/apply-discovery-review-reconciliation.mjs --generate
 *   node scripts/apply-discovery-review-reconciliation.mjs --precheck
 *   node scripts/apply-discovery-review-reconciliation.mjs --apply --manifest=reports/discovery-review-reconciliation-2026-08-02.json
 *
 * Requires .env SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. No SQL.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const {
  simulateQueueAutomation,
  buildReconciliationManifestEntry,
  ACTION,
  AUTO_RESOLVER_VERSION
} = require(path.join(root, "netlify/functions/lib/discovery-auto-resolver.js"));
const { hasStrongIndividualSailingEvidence } = require(
  path.join(root, "netlify/functions/lib/discovery-non-sailing-filter.js")
);
const { loadPortsCatalogue } = require(path.join(root, "netlify/functions/lib/discovery-departure-port.js"));

const MANIFEST_PATH = path.join(root, "reports/discovery-review-reconciliation-2026-08-02.json");

function parseArgs(argv) {
  const args = { generate: false, precheck: false, apply: false, manifest: MANIFEST_PATH };
  for (const arg of argv.slice(2)) {
    if (arg === "--generate") args.generate = true;
    if (arg === "--precheck") args.precheck = true;
    if (arg === "--apply") args.apply = true;
    if (arg.startsWith("--manifest=")) args.manifest = arg.slice("--manifest=".length);
  }
  return args;
}

async function loadSnapshot(sb) {
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
    "discovered_cruises?select=id,external_key,status,cruise_line_id,official_url,review_reason&limit=5000"
  );
  return { items, lines, ships, aliases, destinations, destAliases, cruises };
}

function buildContext(snapshot) {
  const linesById = Object.fromEntries((snapshot.lines || []).map((l) => [l.id, l]));
  const cruisesByKey = Object.fromEntries((snapshot.cruises || []).map((c) => [c.external_key, c]));
  const cruisesById = Object.fromEntries((snapshot.cruises || []).map((c) => [c.id, c]));
  return {
    linesById,
    lineNameById: Object.fromEntries((snapshot.lines || []).map((l) => [l.id, l.name])),
    ships: snapshot.ships || [],
    aliases: snapshot.aliases || [],
    destinations: snapshot.destinations || [],
    destinationAliases: snapshot.destAliases || [],
    cruisesByKey,
    cruisesById,
    ports: loadPortsCatalogue()
  };
}

function findCruiseForItem(item, context) {
  const keys = [
    item.payload?.external_key,
    ...(item.affected_external_keys || [])
  ].filter(Boolean);
  for (const key of keys) {
    if (context.cruisesByKey[key]) return context.cruisesByKey[key];
  }
  if (item.cruise_id) return context.cruisesById[item.cruise_id] || null;
  return null;
}

function safetyCheckReject(entry, item, cruise, context) {
  const extract = item.payload?.extract || {};
  const blocked = hasStrongIndividualSailingEvidence({
    url: entry.source_url,
    title: extract.title || entry.source_title,
    description: extract.description,
    ship_id: item.payload?.ship_id || item.payload?.diagnostics?.ship_id,
    departure_date: item.payload?.diagnostics?.departure_date,
    departure_port: cruise?.departure_port,
    ships: context.ships.filter((s) => s.cruise_line_id === item.cruise_line_id)
  });
  return { safe: !blocked, blocked };
}

async function generateManifest(sb) {
  const snapshot = await loadSnapshot(sb);
  const context = buildContext(snapshot);
  const { results, summary } = simulateQueueAutomation(snapshot.items || [], context);
  const entries = [];
  const safetyFailures = [];

  for (let i = 0; i < (snapshot.items || []).length; i += 1) {
    const item = snapshot.items[i];
    const result = results[i];
    const cruise = findCruiseForItem(item, context);
    const entry = buildReconciliationManifestEntry(item, result, cruise);
    entries.push(entry);

    if (entry.proposed_outcome === ACTION.AUTO_REJECT) {
      const check = safetyCheckReject(entry, item, cruise, context);
      if (!check.safe) {
        safetyFailures.push({ review_item_id: item.id, source_url: entry.source_url, reason: "strong_sailing_evidence" });
      }
    }
  }

  const manifest = {
    generated_at: new Date().toISOString(),
    resolver_version: AUTO_RESOLVER_VERSION,
    queue_total: summary.total,
    summary: {
      auto_reject: summary.auto_reject,
      ship_catalogue_maintenance: summary.ship_maintenance,
      unique_ship_maintenance: summary.unique_ship_maintenance,
      cruise_line_configuration: summary.line_config,
      human_review: summary.human_review,
      auto_publish: summary.auto_publish,
      auto_resolve: summary.auto_resolve
    },
    safety_check: {
      passed: safetyFailures.length === 0,
      failures: safetyFailures
    },
    items: entries
  };

  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log("Manifest written:", MANIFEST_PATH);
  console.log("Summary:", manifest.summary);
  if (safetyFailures.length) {
    console.error("SAFETY CHECK FAILED:", safetyFailures.length, "items");
    process.exit(1);
  }
  return manifest;
}

async function applyManifest(sb, manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest.safety_check?.passed) {
    throw new Error("Manifest failed safety check — aborting apply");
  }

  const rollback = { generated_at: new Date().toISOString(), items: [] };
  const report = { updated: 0, skipped: 0, failed: [], maintenance_created: 0 };

  const shipMaintSeen = new Set();
  const lineConfigSeen = new Set();

  for (const entry of manifest.items || []) {
    try {
      const reviewRows = await sb.get(
        `cruise_discovery_review_items?id=eq.${encodeURIComponent(entry.review_item_id)}&select=*&limit=1`
      );
      const review = reviewRows?.[0];
      if (!review || review.status !== "pending") {
        report.skipped += 1;
        continue;
      }
      if (review.status !== entry.current_review_status) {
        report.skipped += 1;
        continue;
      }

      rollback.items.push({
        review_item_id: entry.review_item_id,
        discovered_cruise_id: entry.discovered_cruise_id,
        review: { status: review.status, detail: review.detail, resolved_at: review.resolved_at },
        cruise: null
      });

      if (entry.proposed_outcome === ACTION.AUTO_REJECT) {
        if (entry.discovered_cruise_id) {
          const cruiseRows = await sb.get(
            `discovered_cruises?id=eq.${encodeURIComponent(entry.discovered_cruise_id)}&select=id,status,review_reason&limit=1`
          );
          const cruise = cruiseRows?.[0];
          if (cruise) {
            rollback.items[rollback.items.length - 1].cruise = {
              status: cruise.status,
              review_reason: cruise.review_reason
            };
            if (cruise.status === entry.current_candidate_status || !entry.current_candidate_status) {
              await sb.patch(`discovered_cruises?id=eq.${encodeURIComponent(entry.discovered_cruise_id)}`, {
                status: "hidden",
                review_reason: `automation:${entry.rejection_or_routing_reason.split(";")[0]}:${AUTO_RESOLVER_VERSION}`,
                last_changed_at: new Date().toISOString()
              });
            }
          }
        }
        await sb.patch(`cruise_discovery_review_items?id=eq.${encodeURIComponent(entry.review_item_id)}`, {
          status: "ignored",
          resolved_at: new Date().toISOString(),
          detail: `Automation reconciled: ${entry.rejection_or_routing_reason}`
        });
        report.updated += 1;
        continue;
      }

      if (entry.proposed_outcome === ACTION.SHIP_MAINTENANCE && entry.ship_maintenance) {
        const key = entry.ship_maintenance.dedupe_key;
        await sb.patch(`cruise_discovery_review_items?id=eq.${encodeURIComponent(entry.review_item_id)}`, {
          status: "ignored",
          resolved_at: new Date().toISOString(),
          detail: "Routed to ship catalogue maintenance (Fleet Audit)."
        });
        if (!shipMaintSeen.has(key)) {
          shipMaintSeen.add(key);
          const existing = await sb.get(
            `cruise_discovery_review_items?status=eq.pending&item_type=eq.missing_ship_url&payload->>entity_group_key=eq.${encodeURIComponent(key)}&select=id&limit=1`
          ).catch(() => []);
          if (!existing?.length) {
            await sb.request("cruise_discovery_review_items", {
              method: "POST",
              body: {
                item_type: "missing_ship_url",
                status: "pending",
                title: `Catalogue: official ship URL needed for ${entry.ship_maintenance.ship_name}`,
                detail: "Ship catalogue maintenance — Fleet Audit. Does not block sailing approval.",
                cruise_line_id: review.cruise_line_id,
                source_url: entry.ship_maintenance.suggested_official_ship_url,
                payload: {
                  entity_group_key: key,
                  ship_id: entry.ship_maintenance.ship_id,
                  maintenance_routing: "fleet_audit",
                  suggested_official_ship_url: entry.ship_maintenance.suggested_official_ship_url,
                  reconciled_from: [entry.review_item_id]
                },
                entity_group_key: key
              }
            });
            report.maintenance_created += 1;
          }
        }
        report.updated += 1;
        continue;
      }

      if (entry.proposed_outcome === ACTION.LINE_CONFIG && entry.line_config_warning) {
        const key = entry.line_config_warning.dedupe_key;
        await sb.patch(`cruise_discovery_review_items?id=eq.${encodeURIComponent(entry.review_item_id)}`, {
          status: "ignored",
          resolved_at: new Date().toISOString(),
          detail: "Routed to cruise-line configuration maintenance."
        });
        if (!lineConfigSeen.has(key)) {
          lineConfigSeen.add(key);
          const existing = await sb.get(
            `cruise_discovery_review_items?status=eq.pending&item_type=eq.missing_url&payload->>entity_group_key=eq.${encodeURIComponent(key)}&select=id&limit=1`
          ).catch(() => []);
          if (!existing?.length) {
            await sb.request("cruise_discovery_review_items", {
              method: "POST",
              body: {
                item_type: "missing_url",
                status: "pending",
                title: `${entry.cruise_line}: configuration required`,
                detail: `Missing field: ${entry.line_config_warning.field}. Operational maintenance only.`,
                cruise_line_id: review.cruise_line_id,
                payload: {
                  entity_group_key: key,
                  configuration_field: entry.line_config_warning.field,
                  maintenance_routing: "line_configuration",
                  reconciled_from: [entry.review_item_id]
                },
                entity_group_key: key
              }
            });
            report.maintenance_created += 1;
          }
        }
        report.updated += 1;
        continue;
      }

      report.skipped += 1;
    } catch (error) {
      report.failed.push({ review_item_id: entry.review_item_id, error: error.message });
    }
  }

  const rollbackPath = path.join(
    root,
    "reports",
    `discovery-review-reconciliation-rollback-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  fs.writeFileSync(rollbackPath, JSON.stringify(rollback, null, 2));

  const pendingAfter = await sb.get("cruise_discovery_review_items?status=eq.pending&select=id,item_type&limit=5000");
  console.log("Apply complete:", report);
  console.log("Rollback manifest:", rollbackPath);
  console.log("Pending review items after:", pendingAfter?.length ?? 0);
  return { report, rollbackPath, pendingAfter: pendingAfter?.length ?? 0 };
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createSupabaseRest(root);

  if (args.generate || args.precheck) {
    await generateManifest(sb);
    if (args.precheck) console.log("Precheck passed.");
    return;
  }

  if (args.apply) {
    if (!fs.existsSync(args.manifest)) {
      await generateManifest(sb);
    }
    await applyManifest(sb, args.manifest);
    return;
  }

  console.log("Use --generate, --precheck, or --apply");
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
