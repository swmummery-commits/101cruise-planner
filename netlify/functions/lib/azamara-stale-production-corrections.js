/**
 * Azamara guarded stale production identity corrections (Phase 6B).
 * Separate from weekly maintenance — identity-critical fields with exact guards.
 */

const { executeControlledProductionApply } = require("./cruise-discovery-global-write-lock");
const { cruiseIdentityKey } = require("./cruise-discovery-ops");
const { snapshotRecordForRollback } = require("./cruise-discovery-maintenance-manifests");
const { AZAMARA_LINE_ID } = require("./azamara-discovery-source");
const { indexExistingAzamaraRecords } = require("./azamara-discovery-writes");
const { packageDepartureDateFromOfficialSailingId } = require("./azamara-weekly-update-policy");

const CORRECTION_OPERATION = "azamara_stale_production_corrections";

function expectedReturnDate(departureDate, nights) {
  if (!departureDate || nights == null) return null;
  const dt = new Date(`${departureDate}T00:00:00.000Z`);
  if (Number.isNaN(dt.getTime())) return null;
  dt.setUTCDate(dt.getUTCDate() + Number(nights));
  return dt.toISOString().slice(0, 10);
}

function buildCorrectionEntry(existing, candidate, options = {}) {
  const officialSailingId = String(existing?.official_sailing_id || "").toUpperCase();
  const fields = [];
  const guards = {
    id: existing.id,
    cruise_line_id: existing.cruise_line_id,
    official_sailing_id: officialSailingId,
    updated_at: existing.updated_at || null
  };

  const sourcePort =
    candidate?.departure_port_meta?.canonicalPortName || candidate?.departure_port || null;
  if (
    sourcePort &&
    String(existing.departure_port || "") !== String(sourcePort) &&
    options.allowPort !== false
  ) {
    fields.push({
      field: "departure_port",
      old_value: existing.departure_port ?? null,
      new_value: sourcePort
    });
    if (candidate?.departure_port_meta) {
      fields.push({
        field: "raw_extract.departure_port_meta",
        old_value: existing.raw_extract?.departure_port_meta ?? null,
        new_value: candidate.departure_port_meta
      });
    }
  }

  const packageDate = packageDepartureDateFromOfficialSailingId(officialSailingId);
  const sourceDeparture = candidate?.departure_date || packageDate || null;
  if (
    sourceDeparture &&
    String(existing.departure_date || "") !== String(sourceDeparture) &&
    packageDate &&
    sourceDeparture === packageDate
  ) {
    fields.push({
      field: "departure_date",
      old_value: existing.departure_date ?? null,
      new_value: sourceDeparture
    });
    const nights = Number(existing.nights ?? candidate?.nights);
    const newReturn = expectedReturnDate(sourceDeparture, nights);
    if (newReturn && String(existing.return_date || "") !== String(newReturn)) {
      fields.push({
        field: "return_date",
        old_value: existing.return_date ?? null,
        new_value: newReturn
      });
    }
  }

  if (!fields.length) return null;

  const patch = {};
  for (const change of fields) {
    if (change.field === "raw_extract.departure_port_meta") {
      patch.raw_extract = {
        ...(existing.raw_extract || {}),
        departure_port_meta: change.new_value
      };
    } else {
      patch[change.field] = change.new_value;
    }
  }

  if (patch.departure_date || patch.return_date) {
    patch.identity_key = cruiseIdentityKey({
      cruiseLineId: existing.cruise_line_id,
      shipId: existing.ship_id,
      departureDate: patch.departure_date || existing.departure_date,
      officialUrl: existing.official_url,
      nights: existing.nights,
      returnDate: patch.return_date || existing.return_date,
      officialSailingId: existing.official_sailing_id
    });
    fields.push({
      field: "identity_key",
      old_value: existing.identity_key ?? null,
      new_value: patch.identity_key
    });
  }

  return {
    production_row_id: existing.id,
    official_sailing_id: officialSailingId,
    ship_id: existing.ship_id,
    guards,
    fields,
    patch,
    candidate_source_url: candidate?.official_url || candidate?.source_url || null
  };
}

async function detectIdentityCollisions(supabase, cruiseLineId, entries) {
  const collisions = [];
  for (const entry of entries) {
    if (!entry.patch?.identity_key) continue;
    const rows = await supabase(
      `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}&identity_key=eq.${encodeURIComponent(
        entry.patch.identity_key
      )}&select=id,official_sailing_id&limit=5`
    );
    const other = (rows || []).find((r) => r.id !== entry.production_row_id);
    if (other) {
      collisions.push({
        official_sailing_id: entry.official_sailing_id,
        identity_key: entry.patch.identity_key,
        collides_with: other.official_sailing_id
      });
    }
  }
  return collisions;
}

async function buildAzamaraStaleProductionCorrectionManifest({
  supabase,
  cruiseLine,
  corrections = []
}) {
  const indexes = await indexExistingAzamaraRecords(supabase, cruiseLine.id);
  const entries = [];
  const skipped = [];

  for (const item of corrections) {
    const sailingId = String(item.official_sailing_id || "").toUpperCase();
    const existing = indexes.officialBySailingId.get(sailingId);
    if (!existing) {
      skipped.push({ official_sailing_id: sailingId, reason: "production_row_not_found" });
      continue;
    }
    if (String(existing.cruise_line_id) !== String(cruiseLine.id)) {
      skipped.push({ official_sailing_id: sailingId, reason: "cruise_line_mismatch" });
      continue;
    }
    const entry = buildCorrectionEntry(existing, item.candidate, item.options);
    if (!entry) {
      skipped.push({ official_sailing_id: sailingId, reason: "no_correction_needed" });
      continue;
    }
    entries.push(entry);
  }

  return {
    operation: CORRECTION_OPERATION,
    cruise_line_id: cruiseLine.id,
    entries,
    skipped,
    total: entries.length,
    identity_collisions: await detectIdentityCollisions(supabase, cruiseLine.id, entries)
  };
}

async function applyAzamaraStaleProductionCorrectionManifest({
  supabase,
  manifest,
  performWrites = true,
  runId = null
}) {
  const stats = {
    attempted: 0,
    applied: 0,
    skipped: 0,
    failed: 0,
    write_details: []
  };

  if (!performWrites) {
    stats.skipped = manifest.entries.length;
    return { stats, performWrites: false };
  }

  for (const entry of manifest.entries || []) {
    stats.attempted += 1;
    try {
      const rows = await supabase(
        `discovered_cruises?id=eq.${encodeURIComponent(entry.production_row_id)}&cruise_line_id=eq.${encodeURIComponent(
          manifest.cruise_line_id
        )}&official_sailing_id=eq.${encodeURIComponent(entry.official_sailing_id)}&select=*&limit=1`
      );
      const current = rows?.[0];
      if (!current) {
        stats.skipped += 1;
        stats.write_details.push({
          official_sailing_id: entry.official_sailing_id,
          result_action: "skipped",
          reason: "row_not_found"
        });
        continue;
      }

      for (const change of entry.fields) {
        if (change.field.startsWith("raw_extract.")) continue;
        const currentValue = current[change.field];
        if (String(currentValue ?? "") !== String(change.old_value ?? "")) {
          throw new Error(`precondition_failed:${change.field}`);
        }
      }
      if (
        entry.guards.updated_at &&
        current.updated_at &&
        entry.guards.updated_at !== current.updated_at
      ) {
        throw new Error("precondition_failed:updated_at");
      }

      const before = snapshotRecordForRollback(current);
      const body = {
        ...entry.patch,
        last_changed_at: new Date().toISOString()
      };
      await supabase(`discovered_cruises?id=eq.${encodeURIComponent(current.id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(body)
      });
      stats.applied += 1;
      stats.write_details.push({
        official_sailing_id: entry.official_sailing_id,
        production_row_id: current.id,
        result_action: "corrected",
        fields: entry.fields.map((f) => f.field),
        rollback_snapshot: before
      });
    } catch (error) {
      stats.failed += 1;
      stats.write_details.push({
        official_sailing_id: entry.official_sailing_id,
        result_action: "failed",
        error: error.message
      });
    }
  }

  return { stats, performWrites: true };
}

async function runAzamaraStaleProductionCorrections({
  supabase,
  cruiseLine,
  corrections,
  performWrites = false,
  runId = null
}) {
  const manifest = await buildAzamaraStaleProductionCorrectionManifest({
    supabase,
    cruiseLine,
    corrections
  });

  if ((manifest.identity_collisions || []).length > 0) {
    return {
      success: false,
      blocked: true,
      reason: "identity_key_collision",
      manifest,
      apply: null,
      global_lock: null
    };
  }

  if (!performWrites) {
    return { success: true, dry_run: true, manifest, apply: null, global_lock: null };
  }

  const wrapped = await executeControlledProductionApply(
    supabase,
    {
      runId,
      lineSlug: cruiseLine.slug || "azamara",
      operation: CORRECTION_OPERATION,
      performWrites: true
    },
    async () =>
      applyAzamaraStaleProductionCorrectionManifest({
        supabase,
        manifest,
        performWrites: true,
        runId
      })
  );

  if (wrapped.blocked) {
    return {
      success: false,
      blocked: true,
      reason: wrapped.reason || "global_production_import_lock_unavailable",
      manifest,
      global_lock: wrapped.global_lock
    };
  }

  return {
    success: (wrapped.writeResult?.stats?.failed || 0) === 0,
    dry_run: false,
    manifest,
    apply: wrapped.writeResult,
    global_lock: wrapped.global_lock
  };
}

module.exports = {
  CORRECTION_OPERATION,
  AZAMARA_LINE_ID,
  buildCorrectionEntry,
  buildAzamaraStaleProductionCorrectionManifest,
  applyAzamaraStaleProductionCorrectionManifest,
  runAzamaraStaleProductionCorrections,
  expectedReturnDate
};
