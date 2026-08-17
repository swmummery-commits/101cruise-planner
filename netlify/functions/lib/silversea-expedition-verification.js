/**
 * Silversea Expedition — post-write verification projection for discovered_cruises.
 * Centralises supported column list so schema drift fails in tests, not after mutation.
 */

const { EXPEDITION_SEMANTIC } = require("./silversea-expedition-semantics");
const { buildItineraryPorts } = require("./silversea-discovery-writes");

/** Columns verified to exist on discovered_cruises (no arrival_port). */
const DISCOVERED_CRUISE_EXPEDITION_VERIFY_COLUMNS = Object.freeze([
  "id",
  "cruise_line_id",
  "ship_id",
  "destination_id",
  "departure_date",
  "return_date",
  "nights",
  "departure_port",
  "itinerary",
  "itinerary_ports",
  "status",
  "official_url",
  "source_url",
  "official_sailing_id",
  "raw_extract"
]);

const DISCOVERED_CRUISE_EXPEDITION_VERIFY_SELECT = DISCOVERED_CRUISE_EXPEDITION_VERIFY_COLUMNS.join(",");

function assertExpeditionVerifyProjectionValid() {
  const forbidden = ["arrival_port"];
  for (const col of forbidden) {
    if (DISCOVERED_CRUISE_EXPEDITION_VERIFY_COLUMNS.includes(col)) {
      throw new Error(`forbidden_verify_column:${col}`);
    }
  }
  if (!DISCOVERED_CRUISE_EXPEDITION_VERIFY_SELECT.includes("raw_extract")) {
    throw new Error("expedition_verify_projection_missing_raw_extract");
  }
}

function verifyStoredExpeditionRow(row, { lineId, manifestEntry, sourceRow } = {}) {
  const issues = [];
  if (!row) issues.push("missing_from_production");
  if (row?.cruise_line_id !== lineId) issues.push("wrong_cruise_line");
  if (row?.status !== "active") issues.push(`unexpected_status:${row?.status}`);
  if (manifestEntry?.candidate) {
    const c = manifestEntry.candidate;
    if (row?.ship_id !== c.ship_id) issues.push("ship_mismatch");
    if (row?.departure_date !== c.departure_date) issues.push("departure_mismatch");
    if (row?.return_date !== c.return_date) issues.push("return_mismatch");
    if (row?.nights !== c.nights) issues.push("nights_mismatch");
    if (row?.destination_id !== c.destination_id) issues.push("destination_mismatch");
    if (manifestEntry.official_sailing_id && row?.official_sailing_id !== manifestEntry.official_sailing_id) {
      issues.push("wrong_official_sailing_id");
    }
  }
  if (sourceRow) {
    const expectedPorts = buildItineraryPorts(sourceRow);
    const actualPorts = row?.itinerary_ports || [];
    if (JSON.stringify(expectedPorts) !== JSON.stringify(actualPorts)) {
      issues.push("itinerary_ports_mismatch");
    }
    for (const stop of sourceRow.itinerary || []) {
      if (stop.kind !== "port") continue;
      if (
        stop.expedition_semantic &&
        stop.expedition_semantic !== EXPEDITION_SEMANTIC.CONVENTIONAL_PORT &&
        stop.port_resolution?.canonicalPortName &&
        actualPorts.includes(stop.port_resolution.canonicalPortName)
      ) {
        issues.push("semantic_leak_in_itinerary_ports");
      }
    }
  }
  if (!row?.raw_extract?.silversea_expedition_controlled_batch && !row?.raw_extract?.controlled_batch) {
    issues.push("missing_controlled_batch_metadata");
  }
  return { ok: issues.length === 0, issues };
}

function verifyStoredExpeditionRows(rows, context = {}) {
  const checks = (rows || []).map((row) => ({
    official_sailing_id: row.official_sailing_id,
    discovered_cruise_id: row.id,
    ...verifyStoredExpeditionRow(row, context)
  }));
  const officialIds = (rows || []).map((r) => r.official_sailing_id).filter(Boolean);
  const duplicateOfficial = officialIds.length !== new Set(officialIds).size;
  return {
    ok: checks.every((c) => c.ok) && !duplicateOfficial,
    duplicate_official_sailing_id: duplicateOfficial,
    verified_count: checks.filter((c) => c.ok).length,
    failed_count: checks.filter((c) => !c.ok).length,
    records: checks
  };
}

module.exports = {
  DISCOVERED_CRUISE_EXPEDITION_VERIFY_COLUMNS,
  DISCOVERED_CRUISE_EXPEDITION_VERIFY_SELECT,
  assertExpeditionVerifyProjectionValid,
  verifyStoredExpeditionRow,
  verifyStoredExpeditionRows
};
