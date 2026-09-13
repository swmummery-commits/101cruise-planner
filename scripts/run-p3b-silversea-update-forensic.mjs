#!/usr/bin/env node
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

function portSequence(value) {
  if (Array.isArray(value)) {
    return value.map((stop) => stop?.port_name || stop?.name || stop?.port_code || stop).filter(Boolean);
  }
  if (value && Array.isArray(value.itinerary_stops)) return portSequence(value.itinerary_stops);
  if (value && Array.isArray(value.itinerary_ports)) return portSequence(value.itinerary_ports);
  return value;
}

function compactValue(field, value) {
  if (value == null) return null;
  if (field === "itinerary_ports" || field === "itinerary") return portSequence(value);
  if (field === "raw_extract" && value && typeof value === "object") {
    return {
      destination_raw: value.destination_raw || value.destination_key || null,
      itinerary: portSequence(value),
      expired_at: value.expired_at || null,
      full_path: value.full_path || null
    };
  }
  if (typeof value === "object") {
    const encoded = JSON.stringify(value);
    return encoded.length > 800 ? `${encoded.slice(0, 800)}…` : JSON.parse(encoded);
  }
  return value;
}

function classifyField(field, row) {
  const identity = [
    "ship_id",
    "departure_date",
    "return_date",
    "nights",
    "departure_port",
    "official_sailing_id",
    "identity_key",
    "external_key"
  ];
  if (identity.includes(field)) return "IDENTITY_CRITICAL";
  if (field === "itinerary_ports" || field === "itinerary") return "IDENTITY_CRITICAL";
  if (["title", "official_url", "source_url", "brochure_fare", "brochure_fare_display", "currency"].includes(field)) {
    return "SAFE_METADATA";
  }
  if (field === "raw_extract") {
    const before = portSequence(row.before?.raw_extract);
    const after = portSequence(row.after?.raw_extract);
    if (JSON.stringify(before) !== JSON.stringify(after) && (Array.isArray(before) || Array.isArray(after))) {
      return "IDENTITY_CRITICAL";
    }
    return "AMBIGUOUS";
  }
  return "SOURCE_CORRECTION";
}

function classifyRow(row) {
  const fields = row.changed_fields || [];
  const classes = [...new Set(fields.map((field) => classifyField(field, row)))];
  if (classes.includes("IDENTITY_CRITICAL")) return "IDENTITY_CRITICAL";
  if (classes.includes("AMBIGUOUS")) return "AMBIGUOUS";
  if (classes.includes("SOURCE_CORRECTION")) return "SOURCE_CORRECTION";
  if (classes.includes("SAFE_METADATA")) return "SAFE_METADATA";
  return "AMBIGUOUS";
}

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const { loadSilverseaWeeklyContext } = require(
    path.join(root, "netlify/functions/lib/silversea-weekly-maintenance")
  );
  const context = await loadSilverseaWeeklyContext(sb, {});
  const report = {
    source: context.orchestration?.source,
    plan: { counts: { insert: (context.orchestration?.tables?.insert_eligible || []).length } },
    summary: { source_healthy: context.orchestration?.gates?.source_healthy }
  };
  const updateEligible = context.orchestration?.tables?.update_eligible || [];
  const rows = (Array.isArray(updateEligible) ? updateEligible : []).map((row) => {
    const classification = classifyRow(row);
    const diffs = (row.changed_fields || []).map((field) => ({
      production: row.production_uuid || row.discovered_cruise_id || row.id,
      source: row.official_sailing_id,
      field,
      old_value: compactValue(field, row.before?.[field] ?? row.current?.[field] ?? null),
      new_value: compactValue(field, row.after?.[field] ?? row.expected?.[field] ?? null),
      source_evidence: row.reason_codes || row.reason || row.evidence || field,
      classification: classifyField(field, row)
    }));
    return {
      official_sailing_id: row.official_sailing_id,
      production_uuid: row.production_uuid || row.discovered_cruise_id,
      changed_fields: row.changed_fields || [],
      classification,
      diffs,
      reason: row.reason || null
    };
  });
  const counts = rows.reduce(
    (acc, row) => {
      acc[row.classification] = (acc[row.classification] || 0) + 1;
      return acc;
    },
    { SAFE_METADATA: 0, SOURCE_CORRECTION: 0, IDENTITY_CRITICAL: 0, AMBIGUOUS: 0 }
  );
  const out = {
    generated_at: new Date().toISOString(),
    writes: 0,
    source_healthy: report.source?.health || report.summary?.source_healthy || null,
    proposed_inserts: report.plan?.counts?.insert ?? report.summary?.proposed_inserts ?? null,
    proposed_updates: rows.length,
    classification_counts: counts,
    rows
  };
  const file = path.join(root, "reports/silversea-p3b-update-forensic-2026-09-09.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ok: true, file, counts, n: rows.length, keys: Object.keys(report || {}) }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
