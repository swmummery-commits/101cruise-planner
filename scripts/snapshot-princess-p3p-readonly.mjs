#!/usr/bin/env node
/**
 * P3P uncached READ-ONLY Princess source harvest. Zero discovered_cruises writes.
 *   node scripts/snapshot-princess-p3p-readonly.mjs MAC
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

try {
  require("dotenv").config({ path: path.join(root, ".env") });
} catch {
  /* optional */
}

const { createMaintenanceSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const source = require(path.join(root, "netlify/functions/lib/princess-discovery-source"));
const { runPrincessWeeklyMaintenance } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-runner"
));
const {
  fingerprintClientId,
  classifyClientIdSource,
  assertNoSecretLeakage,
  redactSecretsFromDiagnostics
} = require(path.join(root, "netlify/functions/lib/princess-source-diagnostics"));

const label = process.argv[2] || "MAC";
const outPath = path.join(root, "reports", `princess-p3p-source-snapshot-${label}-${Date.now()}.json`);

async function main() {
  const startedMs = Date.now();
  const started = new Date().toISOString();
  const resolved = await source.resolvePclClientIdDetailed();
  const clientFingerprint = fingerprintClientId(resolved.value);
  const clientSource = resolved.source || classifyClientIdSource();

  const fetchResult = await source.fetchAllPrincessRawSailings({
    collectDiagnostics: true,
    futureOnly: true
  });
  const sourceDiagnostics = redactSecretsFromDiagnostics(fetchResult.source_diagnostics || null);

  let weekly = null;
  let weeklyError = null;
  try {
    const sb = createMaintenanceSupabase(root);
    weekly = await runPrincessWeeklyMaintenance({
      supabase: sb,
      dryRun: true,
      performWrites: false,
      writeMode: "weekly_maintenance",
      triggerType: "p3p_readonly_snapshot",
      collectSourceDiagnostics: true
    });
  } catch (error) {
    weeklyError = error.message || "weekly_snapshot_failed";
  }

  const summary = weekly?.summary || {};
  const bootstrapAttempt = sourceDiagnostics?.bootstrap?.attempts?.[0] || null;
  const catalogueAttempts = sourceDiagnostics?.catalogue?.attempts || [];
  const report = {
    label,
    environment_class: label,
    started,
    finished: new Date().toISOString(),
    runtime_ms: Date.now() - startedMs,
    discovered_cruises_writes: 0,
    effective_client_id: clientFingerprint,
    client_id_source: clientSource,
    bootstrap: {
      ok: fetchResult.session?.ok !== false && !fetchResult.fetch_failed
        ? true
        : Boolean(sourceDiagnostics?.bootstrap?.attempts?.[0]?.http_status >= 200 &&
            sourceDiagnostics?.bootstrap?.attempts?.[0]?.http_status < 300),
      http_status: bootstrapAttempt?.http_status ?? null,
      bookingcompany: sourceDiagnostics?.session?.bookingcompany || fetchResult.session?.bookingCompany || null,
      cookie_count: sourceDiagnostics?.session?.cookie_count ?? sourceDiagnostics?.bootstrap?.cookie_count ?? null,
      cookie_present: sourceDiagnostics?.session?.cookie_present ?? Boolean(sourceDiagnostics?.bootstrap?.cookie_present)
    },
    catalogue: {
      statuses: catalogueAttempts.map((row) => ({
        attempt: row.attempt || null,
        http_status: row.http_status ?? null,
        elapsed_ms: row.elapsed_ms ?? null,
        bookingcompany: row.bookingcompany || row.request?.bookingcompany || null,
        productcompany: row.productcompany || row.request?.productcompany || null,
        cookie_present: row.cookie_present ?? row.bootstrap_cookies_used ?? row.request?.cookie_present ?? null,
        client_id_present: row.pcl_client_id_present ?? row.client_id_included ?? row.request?.pcl_client_id_present ?? null
      })),
      last_http_status: catalogueAttempts.length
        ? catalogueAttempts[catalogueAttempts.length - 1].http_status
        : null
    },
    official_group_count: fetchResult.raw_group_count ?? fetchResult.num_found_official ?? null,
    expanded_count: fetchResult.products?.length ?? fetchResult.audit?.expanded_sailings ?? null,
    eligible_count: summary.eligible_total ?? null,
    source_hash: summary.snapshot_id ?? summary.source_snapshot_id ?? null,
    fetch_failed: fetchResult.fetch_failed === true,
    failure_class: sourceDiagnostics?.failure_class || null,
    source_diagnostics: sourceDiagnostics,
    weekly: weekly
      ? {
          ok: weekly.ok === true,
          terminal_status: weekly.terminal_status || summary.terminal_status || null,
          reason: weekly.reason || null,
          official_source_total: summary.official_source_total ?? null,
          eligible_total: summary.eligible_total ?? null,
          active_production_total: summary.active_production_total ?? null,
          snapshot_id: summary.snapshot_id ?? null,
          resolution_rates: summary.resolution_rates || null,
          unexplained_active_rows: summary.unexplained_active_rows ?? null,
          proposed_inserts: summary.proposed_inserts ?? 0,
          proposed_updates: summary.proposed_updates ?? 0,
          inserts: summary.inserts ?? 0,
          updates: summary.updates ?? 0,
          inventory_changed: summary.inventory_changed === true
        }
      : { ok: false, error: weeklyError },
    eligible_official_ids: summary.frozen_source?.official_ids || [],
    request_construction: sourceDiagnostics?.request || bootstrapAttempt?.request || null
  };

  const leak = assertNoSecretLeakage(report);
  if (!leak.ok) {
    throw new Error(`secret leakage in snapshot: ${leak.leaks.join(",")}`);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        ok: fetchResult.fetch_failed !== true,
        path: outPath,
        label,
        client_id_source: clientSource,
        client_id_sha256: clientFingerprint.sha256,
        bootstrap_status: report.bootstrap.http_status,
        catalogue_last_status: report.catalogue.last_http_status,
        official_group_count: report.official_group_count,
        expanded_count: report.expanded_count,
        eligible_count: report.eligible_count,
        source_hash: report.source_hash,
        failure_class: report.failure_class,
        runtime_ms: report.runtime_ms,
        writes: 0
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message || String(error) }));
  process.exit(1);
});
