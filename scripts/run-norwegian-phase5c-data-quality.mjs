#!/usr/bin/env node
/**
 * Norwegian Cruise Line Phase 5C — data quality completion (25 voyages only).
 *
 *   node scripts/run-norwegian-phase5c-data-quality.mjs --dry-run
 *   NORWEGIAN_ENRICHMENT_WRITE_ENABLED=true node scripts/run-norwegian-phase5c-data-quality.mjs --apply --confirm=NORWEGIAN-PHASE5C-DATA-QUALITY
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { execSync } from "child_process";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const { createMaintenanceSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const adapter = require(path.join(root, "netlify/functions/lib/norwegian-discovery-adapter"));
const writes = require(path.join(root, "netlify/functions/lib/norwegian-discovery-writes"));
const enrichment = require(path.join(root, "netlify/functions/lib/norwegian-discovery-enrichment-writes"));
const destMap = require(path.join(root, "netlify/functions/lib/norwegian-destination-mapping"));
const poc = require(path.join(root, "netlify/functions/lib/norwegian-port-of-call-mappings"));
const {
  resolveNorwegianDiscoveryMode,
  assertNorwegianWritesAllowed
} = require(path.join(root, "netlify/functions/lib/norwegian-discovery-mode"));
const {
  loadMaintenanceLockStatus,
  acquireMaintenanceDbLock,
  releaseMaintenanceDbLock,
  weeklyLockKey
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks"));
const { perthCalendarDate } = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const { resetPortsCache } = require(path.join(root, "netlify/functions/lib/discovery-departure-port"));

const REPORT_DIR = path.join(root, "reports");
const PHASE4_MANIFEST = path.join(
  root,
  "reports/norwegian-phase4-controlled-batch-manifest-norwegian-phase4-2026-08-13-2026-08-13T01-58-40-170Z.json"
);
const PHASE5B_DRY_RUN = path.join(
  root,
  "reports/norwegian-phase5b-dry-run-norwegian-phase5b-2026-08-13-2026-08-13T02-16-41-354Z.json"
);
const APPLY_CONFIRMATION = "NORWEGIAN-PHASE5C-DATA-QUALITY";

function loadEnv() {
  try {
    require("dotenv").config({ path: path.join(root, ".env") });
    require("dotenv").config({ path: path.join(root, ".env.local") });
  } catch {
    /* optional */
  }
}

loadEnv();

function writeReport(name, data) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const p = path.join(REPORT_DIR, name);
  fs.writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`);
  return p;
}

function parseArgs(argv) {
  const args = { dryRun: true, apply: false, confirm: null, full: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") args.dryRun = true;
    if (arg === "--apply") {
      args.apply = true;
      args.dryRun = false;
    }
    if (arg === "--full") args.full = true;
    if (arg.startsWith("--confirm=")) args.confirm = String(arg.split("=")[1]).trim();
  }
  if (args.full) {
    args.dryRun = true;
    args.apply = true;
  }
  return args;
}

async function loadPopulation(sb) {
  const phase4 = JSON.parse(fs.readFileSync(PHASE4_MANIFEST, "utf8"));
  const indexes = await writes.indexExistingNorwegianRecords(sb, enrichment.NCL_LINE_ID);
  const genuine = indexes.rows.filter((r) => enrichment.isGenuineInventoryRow(r));
  const legacy = indexes.rows.filter((r) => enrichment.isLegacyGenericDiscoveryRow(r));
  const byOfficial = new Map(genuine.map((r) => [r.official_sailing_id, r]));
  const matches = [];
  const missing = [];
  for (const entry of phase4.entries) {
    const row = byOfficial.get(entry.official_sailing_id);
    if (row) matches.push({ manifest: entry, db: row });
    else missing.push(entry.official_sailing_id);
  }
  const extras = genuine.filter((r) => !phase4.entries.some((e) => e.official_sailing_id === r.official_sailing_id));
  return {
    manifest_count: phase4.entries.length,
    db_genuine_count: genuine.length,
    exact_match: missing.length === 0 && extras.length === 0 && matches.length === 25,
    missing,
    extras: extras.map((r) => r.official_sailing_id),
    matches,
    legacy_count: legacy.length,
    legacy_snapshots: legacy.map((r) => ({
      id: r.id,
      status: r.status,
      official_url: r.official_url,
      official_sailing_id: r.official_sailing_id,
      external_key: r.external_key
    })),
    db_rows_by_official: byOfficial
  };
}

function auditUnresolvedPortsFromPhase5B() {
  const dry = JSON.parse(fs.readFileSync(PHASE5B_DRY_RUN, "utf8"));
  const audit = new Map();
  for (const entry of dry.entries) {
    for (const port of entry.enrichment?.resolved_ports || []) {
      if (port.classification !== "UNRESOLVED") continue;
      const key = `${port.source_port}|${port.port_code || ""}`;
      if (!audit.has(key)) {
        audit.set(key, { source: port.source_port, code: port.port_code || null, voyages: 0 });
      }
      audit.get(key).voyages += 1;
    }
  }
  return [...audit.values()];
}

function auditPortMappings() {
  resetPortsCache();
  const phase5bUnresolved = auditUnresolvedPortsFromPhase5B();
  return phase5bUnresolved.map((row) => {
    const mapping = poc.getPortOfCallMapping(row.code);
    const resolved = enrichment.resolvePortOfCall(row.source, row.code);
    let classification = "UNRESOLVED";
    if (mapping?.classification === "DISTINCT_PORT_REQUIRED") classification = "DISTINCT_PORT_REQUIRED";
    else if (mapping?.classification === "NEW_PORT_REQUIRED") classification = "NEW_PORT_REQUIRED";
    else if (resolved.classification === "EXACT") classification = "EXACT";
    else if (resolved.classification === "EXISTING_ALIAS") classification = "EXISTING_ALIAS";
    else if (resolved.classification === "SAFE_EQUIVALENT") classification = "SAFE_EQUIVALENT";
    else if (resolved.classification === "AMBIGUOUS") classification = "AMBIGUOUS";
    return {
      ncl_name: row.source,
      port_code: row.code,
      canonical_port: mapping?.canonical_name || resolved.canonical_port,
      country: mapping?.country || null,
      classification,
      action: resolved.classification === "UNRESOLVED" ? "review" : mapping ? "code_map_and_catalogue" : "catalogue_only",
      affected_voyage_count: row.voyages,
      resolved_now: resolved.classification !== "UNRESOLVED"
    };
  });
}

async function buildDestinationPlan(matches, destinations) {
  return matches.map(({ manifest, db }) => {
    const assignment = destMap.resolveNorwegianDestinationAssignment({
      destination_codes: manifest.destination_codes,
      dbRow: db,
      destinations
    });
    return {
      discovered_cruise_id: db.id,
      official_sailing_id: manifest.official_sailing_id,
      itinerary_code: manifest.itinerary_code,
      ncl_codes: assignment.destination_codes,
      proposed_slug: assignment.proposed_slug,
      destination_id: assignment.destination_id,
      destination_name: assignment.destination_name,
      method: assignment.method,
      confidence: assignment.confidence,
      blocked: !assignment.destination_id
    };
  });
}

function runTests() {
  const ncl = execSync("npm run test:norwegian-discovery", { cwd: root, encoding: "utf8" });
  let shared = "";
  try {
    shared = execSync("npm run test:discovery-departure-port", { cwd: root, encoding: "utf8" });
  } catch (err) {
    shared = `${err.stdout || ""}\n${err.stderr || ""}`;
  }
  const nclPass = /Norwegian discovery tests passed \((\d+)\)/.exec(ncl);
  const sharedPassed = (shared.match(/^✓/gm) || []).length;
  const sharedTotal = sharedPassed + (shared.match(/^✗/gm) || []).length;
  return {
    ncl: { passed: Number(nclPass?.[1] || 0), ok: Boolean(nclPass) },
    shared: {
      passed: sharedPassed,
      total: sharedTotal,
      ok: sharedPassed === 36 && sharedTotal === 37
    }
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createMaintenanceSupabase(root);
  const today = perthCalendarDate();
  const runId = `norwegian-phase5c-${today}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const startingSha = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
  const summary = {
    run_id: runId,
    starting_sha: startingSha,
    production_voyage_inserts: 0,
    new_publicly_active: 0
  };

  summary.tests_pre = runTests();
  if (!summary.tests_pre.ncl.ok || summary.tests_pre.ncl.passed < 89) {
    throw new Error(`NCL tests failed: ${summary.tests_pre.ncl.passed}`);
  }

  summary.population = await loadPopulation(sb);
  if (!summary.population.exact_match) {
    throw new Error(`Population mismatch missing=${summary.population.missing.length}`);
  }

  summary.port_audit = auditPortMappings();
  summary.port_audit_unresolved = summary.port_audit.filter((r) => !r.resolved_now).length;

  if (args.dryRun && !args.apply) {
    execSync("node scripts/apply-norwegian-phase5c-port-reference-data.mjs --dry-run", { cwd: root, stdio: "inherit" });
  }

  let destinations = await sb("destinations?select=id,name,slug,status,classification_enabled&order=slug.asc");
  summary.destination_code_audit = destMap.auditNorwegianDestinationCodes(
    summary.population.matches.map(({ manifest }) => ({ destination_codes: manifest.destination_codes }))
  );
  summary.destination_plan = await buildDestinationPlan(summary.population.matches, destinations);
  summary.destination_blocked = summary.destination_plan.filter((r) => r.blocked).length;

  if (args.dryRun && !args.apply) {
    resetPortsCache();
    const dryRunManifest = await enrichment.buildDryRunManifest(
      summary.population.matches.map((m) => m.manifest),
      summary.population.db_rows_by_official,
      { fetchDelayMs: 300 }
    );
    summary.enrichment_dry_run = {
      page_stats: dryRunManifest.page_stats,
      port_totals: dryRunManifest.port_totals,
      outcome_counts: dryRunManifest.outcome_counts,
      proposed_updates: dryRunManifest.proposed_updates,
      semantic_audit: dryRunManifest.entries.map((e) => ({
        official_sailing_id: e.official_sailing_id,
        semantic: e.enrichment?.semantic_validation?.status,
        title: e.proposal?.patch?.itinerary,
        admin_quality: e.admin_quality
      }))
    };
    summary.dry_run_path = writeReport(`norwegian-phase5c-dry-run-${runId}.json`, summary);
    console.log(JSON.stringify({ ok: true, mode: "dry-run", summary: {
      port_audit_unresolved: summary.port_audit_unresolved,
      destination_blocked: summary.destination_blocked,
      port_totals: summary.enrichment_dry_run.port_totals,
      outcome_counts: summary.enrichment_dry_run.outcome_counts,
      semantic_audit: summary.enrichment_dry_run.semantic_audit
    } }, null, 2));
    return;
  }

  if (args.confirm !== APPLY_CONFIRMATION) throw new Error(`--confirm=${APPLY_CONFIRMATION} required`);
  assertNorwegianWritesAllowed(resolveNorwegianDiscoveryMode("controlled_enrichment"));

  const lock = await acquireMaintenanceDbLock(sb, {
    lockKey: enrichment.CONTROLLED_ENRICHMENT_LOCK_KEY,
    ownerId: runId,
    runId,
    leaseSeconds: 900
  });
  if (!lock.acquired) throw new Error("Could not acquire enrichment lock");

  try {
    execSync("node scripts/apply-norwegian-phase5c-port-reference-data.mjs --apply", { cwd: root, stdio: "inherit" });
    resetPortsCache();
    destinations = await sb("destinations?select=id,name,slug,status,classification_enabled&order=slug.asc");
    summary.destination_plan = await buildDestinationPlan(summary.population.matches, destinations);
    if (summary.destination_plan.some((r) => r.blocked)) {
      throw new Error(`Destination plan blocked for ${summary.destination_plan.filter((r) => r.blocked).length} voyages`);
    }

    summary.destination_apply = { attempted: 0, updated: 0, snapshots: [] };
    for (const row of summary.destination_plan) {
      summary.destination_apply.attempted += 1;
      const before = await sb(`discovered_cruises?id=eq.${encodeURIComponent(row.discovered_cruise_id)}&select=*&limit=1`);
      const prev = before?.[0];
      const updated = await sb(`discovered_cruises?id=eq.${encodeURIComponent(row.discovered_cruise_id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: { destination_id: row.destination_id, last_changed_at: new Date().toISOString() }
      });
      summary.destination_apply.updated += 1;
      summary.destination_apply.snapshots.push({
        discovered_cruise_id: row.discovered_cruise_id,
        before: { destination_id: prev?.destination_id ?? null },
        after: { destination_id: updated?.[0]?.destination_id ?? null }
      });
    }

    const indexes = await writes.indexExistingNorwegianRecords(sb, enrichment.NCL_LINE_ID);
    const genuineByOfficial = new Map(
      indexes.rows.filter((r) => enrichment.isGenuineInventoryRow(r)).map((r) => [r.official_sailing_id, r])
    );
    const dryRunManifest = await enrichment.buildDryRunManifest(
      summary.population.matches.map((m) => m.manifest),
      genuineByOfficial,
      { fetchDelayMs: 300 }
    );
    summary.enrichment_apply = await enrichment.applyEnrichmentManifest({ dryRunManifest, supabase: sb, runId });

    const indexesAfter = await writes.indexExistingNorwegianRecords(sb, enrichment.NCL_LINE_ID);
    const genuineAfter = new Map(
      indexesAfter.rows.filter((r) => enrichment.isGenuineInventoryRow(r)).map((r) => [r.official_sailing_id, r])
    );
    const idemDryRun = await enrichment.buildDryRunManifest(
      summary.population.matches.map((m) => m.manifest),
      genuineAfter,
      { fetchDelayMs: 300 }
    );
    summary.idempotency = { proposed_updates: idemDryRun.proposed_updates, passed: idemDryRun.proposed_updates === 0 };

    const line = (await sb(`ci_cruise_lines?slug=eq.norwegian-cruise-line&select=id,name&limit=1`))?.[0];
    const ships = await sb(
      `ci_cruise_ships?cruise_line_id=eq.${line.id}&select=id,name,cruise_line_id,active,official_line_ship_id&order=name.asc`
    );
    summary.reconciliation = (
      await adapter.simulateNorwegianDiscovery({
        cruiseLine: line,
        ships,
        today,
        supabaseQuery: (q) => sb(q),
        runEnrichment: false
      })
    ).production_reconciliation;

    summary.review_table = dryRunManifest.entries.map((entry) => {
      const dbRow = genuineByOfficial.get(entry.official_sailing_id);
      const dest = summary.destination_plan.find((d) => d.official_sailing_id === entry.official_sailing_id);
      return {
        ship: entry.ship_name,
        departure: entry.departure_date,
        nights: dbRow?.nights,
        embark: entry.embark_port,
        disembark: entry.enrichment?.disembark?.canonical || null,
        destination: dest?.destination_name,
        title: entry.proposal?.patch?.itinerary,
        port_resolution: entry.proposal?.port_summary || entry.enrichment?.port_summary,
        enrichment_status: entry.proposal?.outcome,
        admin_quality: entry.admin_quality,
        admin_issues: entry.admin_issues,
        semantic_status: entry.enrichment?.semantic_validation?.status
      };
    });

    summary.quality_summary = summary.review_table.reduce(
      (acc, row) => {
        acc[row.admin_quality] = (acc[row.admin_quality] || 0) + 1;
        return acc;
      },
      { PASS: 0, REVIEW: 0, FAIL: 0 }
    );
  } finally {
    await releaseMaintenanceDbLock(sb, { lockKey: enrichment.CONTROLLED_ENRICHMENT_LOCK_KEY, ownerId: runId });
  }

  summary.tests_post = runTests();
  summary.production_voyage_updates =
    (summary.destination_apply?.updated || 0) + (summary.enrichment_apply?.stats?.updated || 0);
  summary.ending_sha = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
  summary.final_report_path = writeReport(`norwegian-phase5c-final-report-${runId}.json`, summary);
  console.log(JSON.stringify({ ok: true, summary: {
    quality_summary: summary.quality_summary,
    port_totals: summary.enrichment_apply?.stats,
    idempotency: summary.idempotency,
    reconciliation: summary.reconciliation?.reconciliation_arithmetic,
    final_report_path: summary.final_report_path
  } }, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
