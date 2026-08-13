#!/usr/bin/env node
/** Re-enrich Phase 12 voyages after port reference-data remediation. */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createMaintenanceSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const enrichment = require(path.join(root, "netlify/functions/lib/norwegian-discovery-enrichment-writes"));
const writes = require(path.join(root, "netlify/functions/lib/norwegian-discovery-writes"));

const CORE_MANIFEST = path.join(
  root,
  "reports/norwegian-phase12-controlled-batch-manifest-norwegian-phase12-2026-08-13-2026-08-13T14-37-48-975Z.json"
);
const DRY_RUN = path.join(
  root,
  "reports/norwegian-phase12-enrichment-dry-run-norwegian-phase12-enrichment-2026-08-13-2026-08-13T15-01-16-129Z.json"
);
const APPLY = process.argv.includes("--apply");
const REPORT_PATH = path.join(root, "reports/norwegian-phase12-port-remediation-reprocess.json");

function loadReviewTargets() {
  const dry = JSON.parse(fs.readFileSync(DRY_RUN, "utf8"));
  return (dry.entries || []).filter((e) => e.admin_quality === "REVIEW").map((e) => e.official_sailing_id);
}

async function main() {
  const targets = loadReviewTargets();
  const sb = createMaintenanceSupabase(root);
  const coreManifest = JSON.parse(fs.readFileSync(CORE_MANIFEST, "utf8"));
  const entries = (coreManifest.entries || []).filter((e) => targets.includes(e.official_sailing_id));
  if (entries.length !== targets.length) {
    throw new Error(`Expected ${targets.length} manifest entries, found ${entries.length}`);
  }

  const indexes = await writes.indexExistingNorwegianRecords(sb, writes.NCL_LINE_ID);
  const genuineByOfficial = new Map(
    indexes.rows.filter((r) => enrichment.isGenuineInventoryRow(r)).map((r) => [r.official_sailing_id, r])
  );

  const dryRunManifest = await enrichment.buildDryRunManifest(entries, genuineByOfficial, {
    fetchDelayMs: 300,
    supabase: sb
  });

  const quality = { PASS: 0, REVIEW: 0, FAIL: 0 };
  for (const e of dryRunManifest.entries || []) {
    quality[e.admin_quality] = (quality[e.admin_quality] || 0) + 1;
  }

  const report = {
    generated_at: new Date().toISOString(),
    mode: APPLY ? "apply" : "dry-run",
    target_count: targets.length,
    port_totals: dryRunManifest.port_totals,
    outcome_counts: dryRunManifest.outcome_counts,
    quality,
    entries: (dryRunManifest.entries || []).map((e) => ({
      official_sailing_id: e.official_sailing_id,
      outcome: e.enrichment?.outcome || e.proposal?.outcome,
      admin_quality: e.admin_quality,
      admin_issues: e.admin_issues,
      unresolved_ports: (e.enrichment?.resolved_ports || []).filter((p) => p.classification === "UNRESOLVED")
    }))
  };

  if (APPLY) {
    const applyResult = await enrichment.applyEnrichmentManifest({
      dryRunManifest,
      supabase: sb,
      runId: "norwegian-phase12-port-remediation"
    });
    report.apply = applyResult.stats;
    const idemDryRun = await enrichment.buildDryRunManifest(entries, genuineByOfficial, {
      fetchDelayMs: 300,
      supabase: sb
    });
    report.idempotency = {
      proposed_updates: idemDryRun.proposed_updates,
      passed: idemDryRun.proposed_updates === 0
    };
  }

  report.passed =
    !report.outcome_counts?.partial_enrichment &&
    quality.REVIEW === 0 &&
    quality.FAIL === 0 &&
    quality.PASS === targets.length;

  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ report_path: REPORT_PATH, passed: report.passed, quality, port_totals: report.port_totals }, null, 2));
  if (!report.passed) process.exit(1);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
