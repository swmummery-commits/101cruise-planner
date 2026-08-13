#!/usr/bin/env node
/**
 * Norwegian Cruise Line Phase 6A — production hardening (no new voyage inserts).
 *
 *   node scripts/run-norwegian-phase6a-hardening.mjs --dry-run
 *   node scripts/run-norwegian-phase6a-hardening.mjs --apply --confirm=NORWEGIAN-PHASE6A
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
const { resetPortsCache } = require(path.join(root, "netlify/functions/lib/discovery-departure-port"));
const { perthCalendarDate } = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const {
  resolveNorwegianDiscoveryMode,
  assertNorwegianWritesAllowed
} = require(path.join(root, "netlify/functions/lib/norwegian-discovery-mode"));
const {
  acquireMaintenanceDbLock,
  releaseMaintenanceDbLock
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks"));

const REPORT_DIR = path.join(root, "reports");
const PHASE6_MANIFEST = path.join(
  root,
  "reports/norwegian-phase6-controlled-batch-manifest-norwegian-phase6-2026-08-13-2026-08-13T02-46-11-712Z.json"
);
const LINE_SLUG = "norwegian-cruise-line";
const APPLY_CONFIRMATION = "NORWEGIAN-PHASE6A";

const REVIEW_IDENTITIES = [
  "BLISS16LAXCSLACAPRQPCLPCTCTGFMHMIA|2026-10-13",
  "BLISS17LAXCSLACAPRQPCLPCTCTGFMHNPIMIA|2027-10-19",
  "BLISS19LAXCSLACAPRQPCLPCTCTGFMHMIANYC|2026-10-13",
  "BLISS19NYCPOPCTGCLNPCLPRQACACSLSFO|2028-04-14",
  "DAWN13JAXNPIHORPDLLXOLIS|2028-04-17",
  "ENCORE6VANVICASTSFOLAX|2027-10-11",
  "GEM7PIRJTRKAKCFUKOTBRIKOPRAV|2027-06-20",
  "JADE10TOKSMZOSAKCZHSMNAHKEEHKG|2027-11-29",
  "JADE11INCSAKNIIAKIAOMHKDNGOOSASMZTOK|2027-10-24",
  "JADE11SINKOHLCHSGNCMYHANHKG|2026-12-23",
  "SPIRIT10SYDQDNESSMELORRTAUAKL|2027-03-10",
  "SPIRIT11LTKDENSVUDRAVLIMYSSYD|2027-12-01"
];

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
  const args = { dryRun: true, apply: false, confirm: null, skipPorts: false, skipEnrichment: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") args.dryRun = true;
    if (arg === "--apply") {
      args.apply = true;
      args.dryRun = false;
    }
    if (arg === "--skip-ports") args.skipPorts = true;
    if (arg === "--skip-enrichment") args.skipEnrichment = true;
    if (arg.startsWith("--confirm=")) args.confirm = String(arg.split("=")[1]).trim();
  }
  return args;
}

async function productionCheckpoint(sb, lineId) {
  const indexes = await writes.indexExistingNorwegianRecords(sb, lineId);
  const rows = indexes.rows || [];
  const legacy = rows.filter((r) => writes.isLegacyGenericRow(r));
  const genuine = rows.filter((r) => !writes.isLegacyGenericRow(r) && r.official_sailing_id);
  const activeGenuine = genuine.filter((r) => r.status === "active");
  const matchRequired = genuine.filter((r) => r.status === "match_required");

  function dupes(keyFn) {
    const map = new Map();
    for (const row of genuine) {
      const key = keyFn(row);
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row.id);
    }
    return [...map.entries()].filter(([, ids]) => ids.length > 1);
  }

  return {
    genuine: genuine.length,
    active_genuine: activeGenuine.length,
    match_required_genuine: matchRequired.length,
    legacy_generic: legacy.length,
    duplicate_official: dupes((r) => r.official_sailing_id),
    duplicate_external: dupes((r) => r.external_key),
    duplicate_identity: dupes((r) => r.identity_key),
    legacy_snapshots: legacy.map((r) => ({
      id: r.id,
      status: r.status,
      official_url: r.official_url,
      external_key: r.external_key,
      official_sailing_id: r.official_sailing_id
    })),
    passed:
      activeGenuine.length === 0 &&
      matchRequired.length === genuine.length &&
      dupes((r) => r.official_sailing_id).length === 0
  };
}

async function liveReconciliation(sb, line, ships, today) {
  const simulation = await adapter.simulateNorwegianDiscovery({
    cruiseLine: line,
    ships: ships || [],
    today,
    supabaseQuery: (q) => sb(q),
    runEnrichment: false
  });
  const elig = simulation.eligibility || {};
  const rec = simulation.production_reconciliation || {};
  return {
    raw_sailings: simulation.raw_sailing_count,
    ocean_total: simulation.ocean_sailing_count,
    within_cutoff: elig.within_21_day_exclusions ?? simulation.within_cutoff_ocean_sailings_shared_cutoff,
    eligible_ocean: elig.publicly_eligible_ocean_sailings,
    cruisetours: elig.cruisetour_or_package_exclusions,
    import_ready: elig.import_ready_ocean_sailings,
    recognised: rec.recognised_existing_eligible,
    outstanding: rec.outstanding_eligible_inserts,
    source_absent: rec.source_absent_existing ?? rec.source_absent_existing_eligible,
    arithmetic_ok:
      rec.reconciliation_arithmetic?.reconciles === true || rec.reconciliation_arithmetic_ok === true,
    arithmetic: rec.reconciliation_arithmetic || rec
  };
}

async function buildReviewSubsetManifest(sb) {
  const core = JSON.parse(fs.readFileSync(PHASE6_MANIFEST, "utf8"));
  const indexes = await writes.indexExistingNorwegianRecords(sb, enrichment.NCL_LINE_ID);
  const byOfficial = new Map(
    indexes.rows.filter((r) => enrichment.isGenuineInventoryRow(r)).map((r) => [r.official_sailing_id, r])
  );
  const entries = [];
  const missing = [];
  for (const id of REVIEW_IDENTITIES) {
    const manifestEntry = core.entries.find((e) => e.official_sailing_id === id);
    const db = byOfficial.get(id);
    if (!manifestEntry || !db) missing.push(id);
    else entries.push({ manifest: manifestEntry, db });
  }
  if (missing.length) throw new Error(`Missing REVIEW subset rows: ${missing.join(", ")}`);
  return { core, entries, indexes, byOfficial };
}

async function reEnrichReviewVoyages(sb, args, runId) {
  resetPortsCache();
  const subset = await buildReviewSubsetManifest(sb);
  const dryRunManifest = await enrichment.buildDryRunManifest(
    subset.entries.map((e) => e.manifest),
    subset.byOfficial,
    { fetchDelayMs: 300 }
  );

  const outcome = dryRunManifest.outcome_counts || {};
  const summary = {
    attempted: subset.entries.length,
    enrichment_ready: outcome.enrichment_ready || 0,
    partial: outcome.partial || 0,
    blocked: outcome.blocked || 0,
    proposed_updates: dryRunManifest.proposed_updates,
    gate_passed: dryRunManifest.dry_run_gate?.passed === true,
    entries: (dryRunManifest.entries || []).map((e) => ({
      official_sailing_id: e.official_sailing_id,
      admin_quality: e.admin_quality,
      enrichment_status: e.enrichment_status,
      unresolved_ports: e.unresolved_ports
    }))
  };

  summary.dry_run_path = writeReport(`norwegian-phase6a-re-enrichment-dry-run-${runId}.json`, dryRunManifest);

  if (!summary.gate_passed) return summary;

  if (args.apply) {
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
      summary.apply = await enrichment.applyEnrichmentManifest({ dryRunManifest, supabase: sb, runId });
      summary.apply_path = writeReport(`norwegian-phase6a-re-enrichment-apply-${runId}.json`, summary.apply);
      summary.updated = summary.apply.stats?.updated || 0;
    } finally {
      await releaseMaintenanceDbLock(sb, { lockKey: enrichment.CONTROLLED_ENRICHMENT_LOCK_KEY, ownerId: runId });
    }
  }

  return summary;
}

async function qualityRecheckPhase6(sb) {
  const core = JSON.parse(fs.readFileSync(PHASE6_MANIFEST, "utf8"));
  const indexes = await writes.indexExistingNorwegianRecords(sb, enrichment.NCL_LINE_ID);
  const byOfficial = new Map(
    indexes.rows.filter((r) => enrichment.isGenuineInventoryRow(r)).map((r) => [r.official_sailing_id, r])
  );
  const matches = core.entries.map((manifest) => {
    const db = byOfficial.get(manifest.official_sailing_id);
    return { manifest, db };
  });
  const dryRunManifest = await enrichment.buildDryRunManifest(
    matches.map((m) => m.manifest),
    byOfficial,
    { fetchDelayMs: 200 }
  );
  const counts = { PASS: 0, REVIEW: 0, FAIL: 0 };
  const reviewRows = [];
  for (const entry of dryRunManifest.entries || []) {
    counts[entry.admin_quality] = (counts[entry.admin_quality] || 0) + 1;
    if (entry.admin_quality !== "PASS") {
      reviewRows.push({
        official_sailing_id: entry.official_sailing_id,
        admin_quality: entry.admin_quality,
        reasons: entry.admin_quality_reasons,
        unresolved_ports: entry.unresolved_ports
      });
    }
  }
  return { counts, review_rows: reviewRows, total: core.entries.length, dryRunManifest };
}

async function verifyAdminApi() {
  const siteUrl = String(
    process.env.NETLIFY_SITE_URL || process.env.URL || "https://admirable-tiramisu-d4da8a.netlify.app"
  ).replace(/\/$/, "");
  const adminToken = String(process.env.ADMIN_API_TOKEN || process.env.DISCOVERY_ADMIN_TOKEN || "").trim();
  if (!adminToken) {
    return { verified: false, reason: "ADMIN_API_TOKEN not configured locally" };
  }
  const response = await fetch(`${siteUrl}/.netlify/functions/cruise-discovery`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      action: "list_cruises",
      cruise_line_slug: "norwegian-cruise-line",
      status: "match_required",
      limit: 100
    })
  });
  const body = await response.json().catch(() => ({}));
  const sample = (body.cruises || body.rows || [])[0] || null;
  const requiredFields = [
    "itinerary",
    "itinerary_ports",
    "disembarkation",
    "destination",
    "source_url",
    "enrichment_status",
    "semantic_validation_status"
  ];
  const fieldsPresent = Object.fromEntries(requiredFields.map((f) => [f, sample ? f in sample : false]));
  return {
    verified: response.status === 200 && sample && requiredFields.every((f) => f in sample),
    status: response.status,
    count: (body.cruises || body.rows || []).length,
    fields_present: fieldsPresent,
    sample_official_sailing_id: sample?.official_sailing_id || null
  };
}

function runTests() {
  const suites = [];
  const run = (name, cmd) => {
    try {
      const out = execSync(cmd, { cwd: root, encoding: "utf8" });
      suites.push({ name, ok: true, tail: out.split("\n").slice(-3).join("\n") });
    } catch (err) {
      suites.push({ name, ok: false, tail: `${err.stdout || ""}\n${err.stderr || ""}`.slice(-500) });
    }
  };
  run("test:norwegian-discovery", "npm run test:norwegian-discovery");
  run("test:cruise-discovery-ops-status", "node scripts/test-cruise-discovery-ops-status.mjs");
  run("test:discovery-departure-port", "npm run test:discovery-departure-port");
  return suites;
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createMaintenanceSupabase(root);
  const today = perthCalendarDate();
  const runId = `norwegian-phase6a-${today}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const line =
    (await sb(`ci_cruise_lines?slug=eq.${LINE_SLUG}&select=id,name,slug,website_url&limit=1`))?.[0] ||
    null;
  if (!line?.id) throw new Error(`Cruise line not found: ${LINE_SLUG}`);
  const ships = await sb(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&select=id,name,cruise_line_id,active,official_line_ship_id&order=name.asc`
  );

  const summary = {
    run_id: runId,
    mode: args.apply ? "apply" : "dry-run",
    starting_origin_main: execSync("git rev-parse origin/main", { cwd: root, encoding: "utf8" }).trim(),
    production_voyage_inserts: 0,
    new_publicly_active: 0,
    temporary_activation_during_phase6a: 0
  };

  summary.tests = runTests();
  summary.checkpoint_before = await productionCheckpoint(sb, line.id);
  if (summary.checkpoint_before.active_genuine > 0) {
    throw new Error(`STOP: ${summary.checkpoint_before.active_genuine} active genuine NCL voyages before Phase 6A`);
  }

  summary.reconciliation_before = await liveReconciliation(sb, line, ships, today);

  if (!args.skipPorts) {
    const portFlag = args.apply ? "--apply" : "--dry-run";
    const portOut = execSync(`node scripts/apply-norwegian-phase6a-port-reference-data.mjs ${portFlag}`, {
      cwd: root,
      encoding: "utf8"
    });
    summary.port_reference = JSON.parse(portOut.trim());
    if (args.apply) resetPortsCache();
  }

  if (!args.skipEnrichment) {
    summary.re_enrichment = await reEnrichReviewVoyages(sb, args, runId);
  }

  summary.quality_recheck = await qualityRecheckPhase6(sb);
  summary.quality_recheck_path = writeReport(`norwegian-phase6a-quality-recheck-${runId}.json`, {
    counts: summary.quality_recheck.counts,
    review_rows: summary.quality_recheck.review_rows
  });

  summary.checkpoint_after = await productionCheckpoint(sb, line.id);
  if (summary.checkpoint_after.active_genuine > 0) {
    throw new Error(`STOP: ${summary.checkpoint_after.active_genuine} active genuine NCL after Phase 6A writes`);
  }

  summary.reconciliation_after = await liveReconciliation(sb, line, ships, today);
  summary.admin_api = await verifyAdminApi();

  if (args.apply && !args.skipEnrichment && summary.re_enrichment?.apply) {
    summary.re_enrichment_idempotency = await reEnrichReviewVoyages(sb, { ...args, apply: false, dryRun: true }, `${runId}-idempotency`);
    summary.re_enrichment_idempotency.proposed_updates =
      summary.re_enrichment_idempotency.proposed_updates ?? 0;
  }

  summary.report_path = writeReport(`norwegian-phase6a-hardening-${runId}.json`, summary);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
