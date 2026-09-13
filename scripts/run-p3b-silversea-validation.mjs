#!/usr/bin/env node
/**
 * P3B Silversea deployed-style read-only proof + duplicate dispatch_id no-op.
 * Writes remain disabled.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
try {
  require("dotenv").config({ path: path.join(root, ".env") });
} catch {}

const { createMaintenanceSupabase, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { runSilverseaWeeklyBackgroundMaintenance } = require(
  path.join(root, "netlify/functions/lib/silversea-weekly-maintenance-dispatch")
);

function classifyUpdate(row = {}) {
  const fields = row.changed_fields || row.field_diffs?.map((d) => d.field) || [];
  const identityFields = ["ship_id", "departure_date", "return_date", "nights", "departure_port", "official_sailing_id"];
  if (fields.some((f) => identityFields.includes(f))) {
    return { classification: "IDENTITY_CRITICAL", reason: "protected_voyage_field_changed" };
  }
  if (fields.includes("itinerary_ports") || fields.includes("itinerary")) {
    return { classification: "IDENTITY_CRITICAL", reason: "itinerary_sequence_or_label_change" };
  }
  if (fields.length === 1 && ["title", "official_url", "source_url", "brochure_fare", "brochure_fare_display", "currency"].includes(fields[0])) {
    return { classification: "SAFE_METADATA", reason: "single_safe_metadata_field" };
  }
  if (fields.includes("raw_extract") && fields.length === 1) {
    return { classification: "AMBIGUOUS", reason: "raw_extract_only_requires_manual_review" };
  }
  if (fields.length) return { classification: "SOURCE_CORRECTION", reason: "non_identity_source_field_change" };
  return { classification: "AMBIGUOUS", reason: "no_field_diff" };
}

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const dispatchId = `p3b-silversea-validation-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const first = await runSilverseaWeeklyBackgroundMaintenance({
    dryRun: true,
    triggerType: "p3b_authorised_validation",
    dispatchId,
    supabaseClient: sb
  });
  const second = await runSilverseaWeeklyBackgroundMaintenance({
    dryRun: true,
    triggerType: "p3b_authorised_validation",
    dispatchId,
    supabaseClient: sb
  });

  const report = first.report || first.summary || {};
  const updates = report.plan?.updates || report.updates || first.report?.plan?.rows || [];
  const updateRows = Array.isArray(updates)
    ? updates.filter((row) => /update/i.test(String(row.action || row.proposed_action || row.classification || "")))
    : [];
  const classified = updateRows.map((row) => {
    const cls = classifyUpdate(row);
    return {
      production: row.production_uuid || row.discovered_cruise_id || row.id,
      source: row.official_sailing_id,
      fields: row.changed_fields || [],
      old_value: row.before || null,
      new_value: row.after || null,
      source_evidence: row.reason || row.evidence || null,
      ...cls
    };
  });
  const counts = classified.reduce((acc, row) => {
    acc[row.classification] = (acc[row.classification] || 0) + 1;
    return acc;
  }, { SAFE_METADATA: 0, SOURCE_CORRECTION: 0, IDENTITY_CRITICAL: 0, AMBIGUOUS: 0 });

  const out = {
    generated_at: new Date().toISOString(),
    dispatch_id: dispatchId,
    first: {
      run_id: first.run_id || first.run_record_id,
      run_record_id: first.run_record_id,
      status: first.summary?.terminal_status || first.reason,
      dry_run: first.dry_run,
      duplicate: first.duplicate_background_invocation === true,
      summary: first.summary || null
    },
    second: {
      run_id: second.run_id,
      run_record_id: second.run_record_id,
      duplicate_background_invocation: second.duplicate_background_invocation === true,
      reason: second.reason,
      summary: second.summary || null
    },
    duplicate_noop_pass:
      second.duplicate_background_invocation === true &&
      second.run_record_id == null &&
      (second.summary?.inserts || 0) === 0,
    writes: 0,
    update_classifications: counts,
    update_rows: classified
  };
  const file = path.join(root, "reports/silversea-p3b-validation-2026-09-09.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ok: true, file, dispatchId, duplicate_noop_pass: out.duplicate_noop_pass, first_run: out.first.run_record_id }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message, stack: error.stack }, null, 2));
  process.exit(1);
});
