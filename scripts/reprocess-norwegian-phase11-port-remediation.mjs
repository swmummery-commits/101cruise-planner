#!/usr/bin/env node
/** Re-enrich Phase 11 voyages after port reference-data remediation. */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createMaintenanceSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const enrichment = require(path.join(root, "netlify/functions/lib/norwegian-discovery-enrichment-writes"));
const writes = require(path.join(root, "netlify/functions/lib/norwegian-discovery-writes"));

const TARGETS = [
  "GETAWAY10REYISAAKUOLDAESAMSZEELEHSOU|2028-06-15",
  "SUN21PIRRHOLMSALYPSDSOKSGASSHAQBJEDMCTDOHABUDBX|2027-09-05"
];
const CORE_MANIFEST = path.join(
  root,
  "reports/norwegian-phase11-controlled-batch-manifest-norwegian-phase11-2026-08-13-2026-08-13T10-25-01-877Z.json"
);
const APPLY = process.argv.includes("--apply");
const REPORT_PATH = path.join(root, "reports/norwegian-phase11-port-remediation-reprocess.json");

async function main() {
  const sb = createMaintenanceSupabase(root);
  const coreManifest = JSON.parse(fs.readFileSync(CORE_MANIFEST, "utf8"));
  const entries = (coreManifest.entries || []).filter((e) => TARGETS.includes(e.official_sailing_id));
  if (entries.length !== TARGETS.length) {
    throw new Error(`Expected ${TARGETS.length} manifest entries, found ${entries.length}`);
  }

  const indexes = await writes.indexExistingNorwegianRecords(sb, writes.NCL_LINE_ID);
  const genuineByOfficial = new Map(
    indexes.rows.filter((r) => enrichment.isGenuineInventoryRow(r)).map((r) => [r.official_sailing_id, r])
  );

  const dryRunManifest = await enrichment.buildDryRunManifest(entries, genuineByOfficial, {
    fetchDelayMs: 300,
    supabase: sb
  });

  const report = {
    generated_at: new Date().toISOString(),
    mode: APPLY ? "apply" : "dry-run",
    targets: TARGETS,
    port_totals: dryRunManifest.port_totals,
    outcome_counts: dryRunManifest.outcome_counts,
    entries: (dryRunManifest.entries || []).map((e) => ({
      official_sailing_id: e.official_sailing_id,
      outcome: e.enrichment?.outcome || e.proposal?.outcome,
      admin_quality: e.admin_quality,
      admin_issues: e.admin_issues,
      unresolved_ports: (e.enrichment?.resolved_ports || []).filter((p) => p.classification === "UNRESOLVED")
    }))
  };

  if (APPLY) {
    const applyResult = await enrichment.applyEnrichmentManifest({ dryRunManifest, supabase: sb, runId: "norwegian-phase11-port-remediation" });
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
    report.outcome_counts?.enrichment_ready === TARGETS.length &&
    report.outcome_counts?.partial_enrichment === 0 &&
    (dryRunManifest.entries || []).every((e) => e.admin_quality === "PASS");

  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ report_path: REPORT_PATH, passed: report.passed, report }, null, 2));
  if (!report.passed) process.exit(1);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
