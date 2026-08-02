#!/usr/bin/env node
/**
 * Dry-run remediation for discovered_cruises departure_port values.
 *
 *   node scripts/remediate-discovered-cruise-departures.mjs --dry-run
 *   node scripts/remediate-discovered-cruise-departures.mjs --apply --manifest=path/to/manifest.json
 *
 * Default: dry-run only. Apply mode requires explicit flag + manifest from dry-run.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const {
  classifyStoredDeparture,
  resolveDepartureFromSource,
  loadPortsCatalogue
} = require(path.join(root, "netlify/functions/lib/discovery-departure-port.js"));

function parseArgs(argv) {
  const args = { dryRun: true, apply: false, manifest: null, status: "active" };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") args.dryRun = true;
    if (arg === "--apply") {
      args.apply = true;
      args.dryRun = false;
    }
    if (arg.startsWith("--manifest=")) args.manifest = arg.slice("--manifest=".length);
    if (arg.startsWith("--status=")) args.status = arg.slice("--status=".length);
  }
  return args;
}

async function supabaseGet(tableQuery) {
  const base = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;
  const response = await fetch(`${base}/rest/v1/${tableQuery}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json"
    }
  });
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${await response.text()}`);
  return response.json();
}

async function supabasePatch(id, body) {
  const base = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const response = await fetch(`${base}/rest/v1/discovered_cruises?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Supabase patch ${response.status}: ${await response.text()}`);
  return response.json();
}

function enrichRow(row) {
  const line = row.ci_cruise_lines?.name || row.cruise_line_name || "";
  const ship = row.ci_cruise_ships?.name || row.ship_name || "";
  const destination = row.destinations?.name || row.destination_name || "";
  return {
    ...row,
    cruise_line_name: line,
    ship_name: ship,
    destination_name: destination
  };
}

function buildProposal(row, ports) {
  const classified = classifyStoredDeparture(row, ports);
  const sourceRetry = resolveDepartureFromSource({
    title: row.raw_extract?.title,
    description: row.raw_extract?.description,
    excerpt: row.raw_extract?.excerpt,
    shipNames: row.raw_extract?.ship_name_guesses,
    shipName: row.ship_name,
    destinationName: row.destination_name
  });

  const proposedRaw =
    sourceRetry.status === "resolved"
      ? sourceRetry
      : classified.proposed && classified.proposed.status === "resolved"
        ? classified.proposed
        : null;
  const proposed =
    proposedRaw && resolveRawPortText(proposedRaw.canonicalPortName).status === "resolved"
      ? proposedRaw
      : null;

  const action =
    !row.departure_port && proposed
      ? "set_canonical"
      : row.departure_port && classified.classification.startsWith("canonical")
        ? "keep"
        : row.departure_port && proposed
          ? "replace_invalid"
          : row.departure_port
            ? "clear_invalid"
            : proposed
              ? "set_canonical"
              : "manual_review";

  return {
    id: row.id,
    cruise_line: row.cruise_line_name,
    ship: row.ship_name,
    title: row.raw_extract?.title || row.itinerary || "",
    departure_date: row.departure_date,
    current_departure_port: row.departure_port || null,
    classification: classified.classification,
    proposed_canonical_port: proposed?.canonicalPortName || null,
    confidence: proposed?.confidence || null,
    reason: proposed?.reason || classified.meta?.reason || sourceRetry.reason || null,
    source_field: proposed?.sourceField || sourceRetry.sourceField || null,
    source_url: row.official_url || row.source_url || null,
    action,
    before_departure_port: row.departure_port || null,
    after_departure_port:
      action === "keep"
        ? row.departure_port
        : action === "clear_invalid"
          ? null
          : proposed?.canonicalPortName || null
  };
}

function summarise(proposals) {
  const summary = {
    total: proposals.length,
    keep: 0,
    set_canonical: 0,
    replace_invalid: 0,
    clear_invalid: 0,
    manual_review: 0,
    by_classification: {},
    australian_by_port: {},
    nz_by_port: {},
    overseas_by_port: {}
  };
  const ports = loadPortsCatalogue();
  const portCountry = new Map(ports.map((p) => [p.canonical_name, p.country]));

  for (const row of proposals) {
    summary[row.action] = (summary[row.action] || 0) + 1;
    summary.by_classification[row.classification] = (summary.by_classification[row.classification] || 0) + 1;
    const canonical = row.after_departure_port || row.current_departure_port;
    if (!canonical) continue;
    const country = String(portCountry.get(canonical) || "").toLowerCase();
    if (country === "australia") summary.australian_by_port[canonical] = (summary.australian_by_port[canonical] || 0) + 1;
    else if (country === "new zealand") summary.nz_by_port[canonical] = (summary.nz_by_port[canonical] || 0) + 1;
    else summary.overseas_by_port[canonical] = (summary.overseas_by_port[canonical] || 0) + 1;
  }
  return summary;
}

async function loadRows(status) {
  const today = new Date().toISOString().slice(0, 10);
  let query =
    `discovered_cruises?select=id,cruise_line_id,ship_id,destination_id,departure_date,departure_port,itinerary,official_url,source_url,status,raw_extract,` +
    `ci_cruise_lines(name),ci_cruise_ships(name),destinations!discovered_cruises_destination_id_fkey(name)&order=departure_date.asc&limit=5000`;
  if (status === "active") {
    query = `discovered_cruises?status=eq.active&departure_date=gte.${today}&select=id,cruise_line_id,ship_id,destination_id,departure_date,departure_port,itinerary,official_url,source_url,status,raw_extract,ci_cruise_lines(name),ci_cruise_ships(name),destinations!discovered_cruises_destination_id_fkey(name)&order=departure_date.asc&limit=5000`;
  } else if (status !== "all") {
    query = `discovered_cruises?status=eq.${encodeURIComponent(status)}&select=id,cruise_line_id,ship_id,destination_id,departure_date,departure_port,itinerary,official_url,source_url,status,raw_extract,ci_cruise_lines(name),ci_cruise_ships(name),destinations!discovered_cruises_destination_id_fkey(name)&order=departure_date.asc&limit=5000`;
  }
  const rows = await supabaseGet(query);
  if (!rows) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  return rows.map(enrichRow);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.apply && !args.manifest) {
    throw new Error("--apply requires --manifest=<approved dry-run manifest>");
  }

  const ports = loadPortsCatalogue();
  const rows = await loadRows(args.status);
  const proposals = rows.map((row) => buildProposal(row, ports));
  const summary = summarise(proposals);
  const generatedAt = new Date().toISOString();
  const manifest = {
    generated_at: generatedAt,
    mode: args.apply ? "apply" : "dry-run",
    status_filter: args.status,
    summary,
    proposals
  };

  const outDir = path.join(root, "reports");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = generatedAt.replace(/[:.]/g, "-");
  const manifestPath = path.join(outDir, `departure-remediation-${stamp}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`Remediation ${args.apply ? "APPLY" : "DRY-RUN"} — ${args.status} records`);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Manifest: ${manifestPath}`);

  const unresolved = proposals.filter((p) => p.action === "manual_review");
  if (unresolved.length) {
    console.log("\nManual review required:");
    for (const row of unresolved) {
      console.log(
        `- ${row.id} | ${row.cruise_line} | ${row.ship} | current=${row.current_departure_port || "—"} | ${row.reason || row.classification}`
      );
    }
  }

  if (!args.apply) {
    console.log("\nNo database writes performed (dry-run).");
    return;
  }

  const approved = JSON.parse(fs.readFileSync(path.resolve(args.manifest), "utf8"));
  const approvedById = new Map((approved.proposals || []).map((p) => [p.id, p]));
  const results = { updated: 0, skipped: 0, failed: 0, rollback: [] };

  for (const row of rows) {
    const plan = approvedById.get(row.id);
    if (!plan || !["set_canonical", "replace_invalid", "clear_invalid"].includes(plan.action)) {
      results.skipped += 1;
      continue;
    }
    if (String(plan.before_departure_port || "") !== String(row.departure_port || "")) {
      results.skipped += 1;
      continue;
    }
    try {
      results.rollback.push({
        id: row.id,
        departure_port: row.departure_port,
        raw_extract: row.raw_extract
      });
      const meta =
        plan.after_departure_port && plan.proposed_canonical_port
          ? {
              rawValue: plan.after_departure_port,
              canonicalPortName: plan.after_departure_port,
              canonicalPortId: null,
              confidence: plan.confidence || "exact",
              status: "resolved",
              reason: null,
              sourceField: plan.source_field || "remediation.apply",
              remediation: true
            }
          : {
              status: "missing",
              reason: "Cleared invalid departure port during remediation",
              remediation: true
            };
      await supabasePatch(row.id, {
        departure_port: plan.after_departure_port,
        raw_extract: {
          ...(row.raw_extract || {}),
          departure_port_meta: meta,
          departure_port_raw: meta.rawValue || null
        },
        last_changed_at: new Date().toISOString()
      });
      results.updated += 1;
    } catch (error) {
      results.failed += 1;
      console.error(`Failed ${row.id}:`, error.message);
    }
  }

  const rollbackPath = path.join(outDir, `departure-remediation-rollback-${stamp}.json`);
  fs.writeFileSync(rollbackPath, JSON.stringify({ generated_at: generatedAt, results, rollback: results.rollback }, null, 2));
  console.log(JSON.stringify(results, null, 2));
  console.log(`Rollback manifest: ${rollbackPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
