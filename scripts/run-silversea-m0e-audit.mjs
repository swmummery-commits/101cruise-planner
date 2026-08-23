#!/usr/bin/env node
/**
 * Silversea Phase M0E — final read-only whole-line integrity + maintenance-readiness audit.
 * NO production or reference writes.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { execSync } from "child_process";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

try {
  require("dotenv").config({ path: path.join(root, ".env") });
  require("dotenv").config({ path: path.join(root, ".env.local") });
} catch {}

export const M0E_RUNNER_PATH = "scripts/run-silversea-m0e-audit.mjs";

function git(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

export function auditFutureInsertPersistence() {
  const classic = require(path.join(root, "netlify/functions/lib/silversea-classic-itinerary-ports-backfill"));
  const { buildDiscoveredCruiseUpsertPayload } = require(path.join(root, "netlify/functions/lib/cruise-discovery-ops"));
  const issues = [];
  const now = new Date().toISOString();
  const merged = { departure_port: "Port", departure_port_meta: null, blocked: false, reason: "new" };
  const payload = classic.assertClassicInsertPayloadIncludesItineraryPorts(
    {
      cruise_line_id: "l",
      ship_id: "s",
      destination_id: "d",
      departure_date: "2028-06-01",
      return_date: "2028-06-08",
      nights: 7,
      departure_port: "Port",
      itinerary: "Port",
      itinerary_ports: ["Piraeus", "Rhodes"],
      official_url: "https://example.com",
      external_key: "ext",
      official_sailing_id: "SL1",
      raw_extract: {}
    },
    merged,
    "k1",
    "active",
    [],
    now
  );
  if (!Array.isArray(payload.itinerary_ports) || payload.itinerary_ports.length !== 2) {
    issues.push("classic_helper_insert");
  }
  const update = buildDiscoveredCruiseUpsertPayload(
    { cruise_line_id: "l", ship_id: "s", destination_id: "d", departure_date: "2028-06-01", return_date: "2028-06-08", nights: 7, departure_port: "Port", itinerary: "Port", itinerary_ports: ["A"], official_url: "https://example.com", external_key: "ext", official_sailing_id: "ID1", raw_extract: {} },
    merged,
    { identity_key: "k", status: "active", reasons: [], now, includeItineraryPorts: false }
  );
  if (Object.prototype.hasOwnProperty.call(update, "itinerary_ports")) issues.push("update_must_omit_ports");
  return { ok: issues.length === 0, issues };
}

export function auditAggregateVerifierSafety() {
  const { buildAuthoritativeVerificationResult } = require(path.join(
    root,
    "netlify/functions/lib/cruise-discovery-controlled-production-run"
  ));
  const masked = buildAuthoritativeVerificationResult({
    aggregateOk: false,
    verification: { ok: true, verified_count: 199, failed_count: 0 }
  });
  const pass = buildAuthoritativeVerificationResult({
    aggregateOk: true,
    verification: { ok: true, verified_count: 199, failed_count: 0 }
  });
  return { ok: masked.ok === false && pass.ok === true, masking_prevented: masked.ok === false, pass_ok: pass.ok === true };
}

export function auditWriterCoverage() {
  const silverseaWrites = fs.readFileSync(path.join(root, "netlify/functions/lib/silversea-discovery-writes.js"), "utf8");
  const controlledRun = fs.readFileSync(path.join(root, "netlify/functions/lib/cruise-discovery-controlled-production-run.js"), "utf8");
  const expiryCron = fs.readFileSync(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-cron.js"), "utf8");
  const expiryRunner = fs.readFileSync(path.join(root, "netlify/functions/lib/cruise-discovery-runner.js"), "utf8");
  const writers = [
    { path: "silversea-discovery-writes.js", uses_global_lock: /ensureGlobalCruiseWriteLockForMutation/.test(silverseaWrites) },
    { path: "cruise-discovery-controlled-production-run.js", uses_global_lock: /withGlobalCruiseWriteLock/.test(controlledRun) },
    { path: "cruise-discovery-maintenance-cron.js", uses_global_lock: /withGlobalCruiseWriteLock/.test(expiryCron) },
    { path: "cruise-discovery-runner.js", uses_global_lock: /assertGlobalCruiseWriteLockHeld/.test(expiryRunner) }
  ];
  const unlocked = writers.filter((w) => !w.uses_global_lock);
  return { writers, unlocked_relevant_count: unlocked.length, ok: unlocked.length === 0 };
}

async function main() {
  const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
  const { indexExistingSilverseaRecords } = require(path.join(root, "netlify/functions/lib/silversea-discovery-writes"));
  const {
    classifySilverseaOfficialInventory,
    auditClassicItineraryPortsPopulation,
    isClassicStoredOfficialRow,
    isExpeditionStoredOfficialRow,
    verifyClassicRepairBatchResults
  } = require(path.join(root, "netlify/functions/lib/silversea-classic-itinerary-ports-backfill"));
  const { buildExpectedItineraryPorts, portsArrayEqual, normalizeStoredPorts } = require(path.join(
    root,
    "netlify/functions/lib/silversea-expedition-itinerary-ports-backfill"
  ));
  const { perthCalendarDate } = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
  const { loadClassificationDestinations } = require(path.join(root, "netlify/functions/lib/destination-queries"));
  const { createMaintenanceSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

  const today = perthCalendarDate();
  const sb = createMaintenanceSupabase(root);
  const line = (await sb(`ci_cruise_lines?slug=eq.${adapter.LINE_SLUG}&select=id,name,slug&limit=1`))?.[0];
  const indexed = await indexExistingSilverseaRecords(sb, line.id);
  const destinations = adapter.catalogueDestinations(await loadClassificationDestinations(async (q) => sb(q)));
  const ships = await sb(`ci_cruise_ships?cruise_line_id=eq.${line.id}&select=id,name,cruise_line_id,official_line_ship_id`);
  const simulation = await adapter.simulateSilverseaInventory({ cruiseLine: line, ships, destinations, existingRows: indexed.rows, today, concurrency: 6 });
  const sourceById = new Map();
  for (const row of simulation.products) if (row.official_sailing_id) sourceById.set(String(row.official_sailing_id).toUpperCase(), row);
  const classicStored = indexed.rows.filter(isClassicStoredOfficialRow);
  const expeditionStored = indexed.rows.filter(isExpeditionStoredOfficialRow);
  const classicAudit = auditClassicItineraryPortsPopulation(classicStored, sourceById, line);
  const expeditionMismatches = [];
  for (const prodRow of expeditionStored) {
    const source = sourceById.get(String(prodRow.official_sailing_id).toUpperCase()) || null;
    const stored = normalizeStoredPorts(prodRow.itinerary_ports);
    let expectedOk = false;
    let expected = [];
    if (source) {
      const built = buildExpectedItineraryPorts(source, line, today);
      expectedOk = built.ok;
      expected = built.ok ? built.ports : [];
    }
    if (!portsArrayEqual(stored, expected) && expectedOk) expeditionMismatches.push(prodRow.official_sailing_id);
  }
  const nmFixture = JSON.parse(fs.readFileSync(path.join(root, "scripts/fixtures/silversea/classic-m0d-non-master-itinerary-ports-backfill.json"), "utf8"));
  const nmVerify = await verifyClassicRepairBatchResults(sb, nmFixture.rows);
  const inventory = classifySilverseaOfficialInventory(indexed.rows);
  const futureInsert = auditFutureInsertPersistence();
  const aggregateVerifier = auditAggregateVerifierSafety();
  const writerCoverage = auditWriterCoverage();
  const classicClean = classicAudit.remaining_repair_candidates === 0 && classicAudit.deferred_unsafe === 0;
  const expeditionClean = expeditionMismatches.length === 0;
  const authorised = classicClean && expeditionClean && futureInsert.ok && aggregateVerifier.ok && writerCoverage.ok;
  const report = {
    phase: "M0E",
    read_only: true,
    inventory,
    classic_audit: classicAudit,
    expedition_mismatches: expeditionMismatches.length,
    non_master_verify: nmVerify,
    future_insert_persistence: futureInsert,
    aggregate_verifier: aggregateVerifier,
    global_lock: writerCoverage,
    m1_authorisation: {
      authorised,
      decision: authorised
        ? "A. SILVERSEA M1 — WEEKLY MAINTENANCE READ-ONLY HARDENING AUTHORISED"
        : "B. SILVERSEA M0E REMEDIATION REQUIRED",
      weekly_maintenance: "NOT ENABLED"
    },
    production_writes: { cruise_inserts: 0, cruise_updates: 0, cruise_deletes: 0, reference_writes: 0 }
  };
  const runId = `silversea-m0e-audit-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const reportPath = path.join(root, "reports", `${runId}.json`);
  fs.mkdirSync(path.join(root, "reports"), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ok: authorised, decision: report.m1_authorisation.decision, report: reportPath }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
