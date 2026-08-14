/**
 * Norwegian Cruise Line — Phase 13 publication apply (match_required → active).
 */

const { promoteNorwegianToActive, perthCalendarDate } = require("./norwegian-maintenance-shared");
const { indexExistingNorwegianRecords } = require("./norwegian-discovery-writes");
const { isGenuineInventoryRow } = require("./norwegian-discovery-adapter");
const { evaluatePublicationDryRunGate } = require("./norwegian-publication-manifest");

async function applyPublicationManifest({
  manifest,
  supabase,
  cruiseLine,
  performWrites = true,
  runId = null,
  maxPromotions = null
}) {
  const gate = evaluatePublicationDryRunGate(manifest);
  if (!gate.passed) {
    const err = new Error(`Publication dry-run gate failed: ${gate.failures.join("; ")}`);
    err.code = "norwegian_publication_gate_failed";
    err.failures = gate.failures;
    throw err;
  }

  const entries = manifest.entries || [];
  const limit = maxPromotions == null ? entries.length : Math.min(entries.length, maxPromotions);
  const batch = entries.slice(0, limit);
  const perthToday = manifest.perth_today || perthCalendarDate();

  const stats = {
    attempted: batch.length,
    promoted: 0,
    skipped: 0,
    failed: 0,
    duplicate_skips: 0,
    inserted_ids: [],
    write_details: []
  };

  const indexes = await indexExistingNorwegianRecords(supabase, cruiseLine.id);
  const byOfficial = new Map(
    indexes.rows.filter((r) => isGenuineInventoryRow(r)).map((r) => [r.official_sailing_id, r])
  );

  for (const entry of batch) {
    const row = byOfficial.get(entry.official_sailing_id);
    if (!row) {
      stats.failed += 1;
      stats.write_details.push({
        official_sailing_id: entry.official_sailing_id,
        result_action: "failed",
        error: "missing_row"
      });
      continue;
    }
    if (row.status === "active") {
      stats.duplicate_skips += 1;
      stats.write_details.push({
        official_sailing_id: entry.official_sailing_id,
        result_action: "already_active"
      });
      continue;
    }
    if (row.status !== "match_required") {
      stats.failed += 1;
      stats.write_details.push({
        official_sailing_id: entry.official_sailing_id,
        result_action: "failed",
        error: `unexpected_status_${row.status}`
      });
      continue;
    }
    if (!performWrites) {
      stats.skipped += 1;
      stats.write_details.push({
        official_sailing_id: entry.official_sailing_id,
        result_action: "dry_run_skip"
      });
      continue;
    }

    try {
      const result = await promoteNorwegianToActive({
        supabase,
        row,
        runId,
        perthToday
      });
      stats.promoted += 1;
      stats.inserted_ids.push(row.id);
      stats.write_details.push(result);
    } catch (error) {
      stats.failed += 1;
      stats.write_details.push({
        official_sailing_id: entry.official_sailing_id,
        result_action: "failed",
        error: error.message || String(error)
      });
    }
  }

  return { stats, gate, manifest_hash: manifest.run_id || null };
}

module.exports = {
  applyPublicationManifest
};
