/**
 * Synchronise Shore Excursions Group ship IDs from SEG's live Google Sheet.
 *
 * Source of truth:
 * https://docs.google.com/spreadsheets/d/1hDh2iUfC9VQZSRGf61MFqS-JDjFmihnf7Xx6897UIFY/edit?gid=0#gid=0
 *
 * Writes are conservative:
 * - confident existing Cruise Intelligence ship matches are refreshed;
 * - reviewed existing SEG-ID assignments are preserved when SEG source metadata is unchanged;
 * - ambiguous/unmatched rows are logged for review;
 * - a changed SEG ID on an already-mapped ship is never overwritten automatically;
 * - ships removed from SEG's sheet are marked missing_from_source, never deleted.
 */

"use strict";

const { resolveCruiseShip } = require("./lib/resolve-cruise-ship");
const {
  DEFAULT_SEG_SHEET_ID,
  DEFAULT_SEG_SHEET_GID,
  DEFAULT_SEG_SOURCE_URL,
  buildSheetCsvUrls,
  extractSegShipRows,
  dedupeSegSourceRows
} = require("./lib/seg-ship-sheet");

const MIN_VALID_SOURCE_ROWS = 25;
const MAX_DETAIL_ROWS = 100;

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

function parseJsonBody(event) {
  try {
    return JSON.parse(event?.body || "{}");
  } catch (_error) {
    return {};
  }
}

function headerValue(event, name) {
  const needle = String(name || "").toLowerCase();
  for (const [key, value] of Object.entries(event?.headers || {})) {
    if (String(key).toLowerCase() === needle) return String(value || "").trim();
  }
  return "";
}

function isNetlifyPlatformScheduledInvocation(event) {
  const scheduled = ["x-netlify-event", "x-nf-event"]
    .some((name) => headerValue(event, name).toLowerCase() === "schedule") ||
    headerValue(event, "netlify-scheduled").toLowerCase() === "true";
  if (!scheduled) return false;
  const body = parseJsonBody(event);
  return typeof body.next_run === "string" && /^\d{4}-\d{2}-\d{2}T/.test(body.next_run);
}

function assertAuthorised(event) {
  if (isNetlifyPlatformScheduledInvocation(event)) return;
  const expected = String(process.env.SEG_SYNC_SECRET || process.env.DISCOVERY_CRON_SECRET || "").trim();
  if (!expected) {
    const error = new Error("SEG sync secret is not configured");
    error.statusCode = 503;
    throw error;
  }
  const provided = headerValue(event, "x-seg-sync-secret") || headerValue(event, "x-discovery-cron-secret");
  if (provided !== expected) {
    const error = new Error("Unauthorized");
    error.statusCode = 401;
    throw error;
  }
}

function supabaseConfig() {
  const baseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!baseUrl || !key) throw new Error("Supabase server configuration is unavailable");
  return { baseUrl, key };
}

async function supabaseRequest(path, options = {}) {
  const { baseUrl, key } = supabaseConfig();
  const method = options.method || "GET";
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(options.prefer ? { Prefer: options.prefer } : {})
  };
  const response = await fetch(`${baseUrl}/rest/v1/${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_error) {
    data = text || null;
  }
  if (!response.ok) {
    const message = data?.message || data?.hint || `${method} ${path} failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

async function createRun(sourceUrl) {
  const result = await supabaseRequest("seg_ship_sync_runs", {
    method: "POST",
    prefer: "return=representation",
    body: { source_url: sourceUrl, status: "running" }
  });
  return Array.isArray(result) ? result[0] : result;
}

async function updateRun(runId, patch) {
  if (!runId) return;
  await supabaseRequest(`seg_ship_sync_runs?id=eq.${encodeURIComponent(runId)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: patch
  });
}

async function fetchSegCsv() {
  const sheetId = String(process.env.SEG_SHIP_SHEET_ID || DEFAULT_SEG_SHEET_ID).trim();
  const gid = String(process.env.SEG_SHIP_SHEET_GID || DEFAULT_SEG_SHEET_GID).trim();
  const urls = buildSheetCsvUrls({ sheetId, gid });
  const failures = [];

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: {
          Accept: "text/csv,text/plain;q=0.9,*/*;q=0.1",
          "User-Agent": "101cruise-SEG-ship-sync/1.0"
        }
      });
      const text = await response.text();
      if (!response.ok) {
        failures.push(`${response.status} ${url}`);
        continue;
      }
      if (!text || text.length < 50 || /^\s*</.test(text)) {
        failures.push(`non-CSV response ${url}`);
        continue;
      }
      return { csvText: text, fetchedUrl: url };
    } catch (error) {
      failures.push(`${error.message} ${url}`);
    }
  }

  throw new Error(`Unable to fetch SEG Google Sheet CSV: ${failures.join(" | ").slice(0, 700)}`);
}

async function listCruiseIntelligenceShips() {
  const result = await supabaseRequest(
    "ci_cruise_ships?select=id,name,cruise_line_id,active,seg_ship_id,seg_ship_name,seg_cruise_line,seg_sync_status,ci_cruise_lines(id,name,slug)&active=eq.true&order=name.asc&limit=5000"
  );
  return Array.isArray(result) ? result : [];
}

async function listShipAliases() {
  try {
    const result = await supabaseRequest(
      "cruise_ship_aliases?select=ship_id,cruise_line_id,raw_alias,normalised_alias,active&or=(active.is.null,active.eq.true)&limit=5000"
    );
    return Array.isArray(result) ? result : [];
  } catch (_error) {
    return [];
  }
}

function compactSourceRow(row) {
  return {
    seg_ship_id: row.segShipId,
    ship_name: row.shipName,
    cruise_line: row.cruiseLine || null,
    row_number: row.sourceRowNumber
  };
}

function normaliseSourceValue(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function buildMappings(sourceRows, ships, aliases) {
  const mappings = [];
  const unmatched = [];
  const ambiguous = [];
  const conflicts = [];
  const proposedByShipId = new Map();
  const existingBySegId = new Map(
    ships.filter((ship) => ship.seg_ship_id).map((ship) => [String(ship.seg_ship_id), ship])
  );

  for (const row of sourceRows) {
    const existingOwner = existingBySegId.get(row.segShipId);
    if (existingOwner) {
      const storedName = normaliseSourceValue(existingOwner.seg_ship_name);
      const storedLine = normaliseSourceValue(existingOwner.seg_cruise_line);
      const sourceName = normaliseSourceValue(row.shipName);
      const sourceLine = normaliseSourceValue(row.cruiseLine);
      const sourceChanged =
        (storedName && sourceName && storedName !== sourceName) ||
        (storedLine && sourceLine && storedLine !== sourceLine);

      if (sourceChanged) {
        conflicts.push({
          type: "existing_seg_id_source_changed",
          ...compactSourceRow(row),
          ci_ship_id: existingOwner.id,
          ci_ship_name: existingOwner.name,
          previous_seg_ship_name: existingOwner.seg_ship_name || null,
          previous_seg_cruise_line: existingOwner.seg_cruise_line || null
        });
        continue;
      }

      const mapping = {
        id: existingOwner.id,
        seg_ship_id: row.segShipId,
        seg_ship_name: row.shipName,
        seg_cruise_line: row.cruiseLine || null
      };
      proposedByShipId.set(String(existingOwner.id), mapping);
      mappings.push(mapping);
      continue;
    }

    const resolution = resolveCruiseShip(ships, row.shipName, row.cruiseLine, aliases);
    if (resolution.status === "ambiguous") {
      ambiguous.push(compactSourceRow(row));
      continue;
    }
    if (resolution.status !== "matched" || !resolution.ship?.id) {
      unmatched.push(compactSourceRow(row));
      continue;
    }

    const ship = resolution.ship;
    const currentSegId = ship.seg_ship_id ? String(ship.seg_ship_id) : "";
    if (currentSegId && currentSegId !== row.segShipId) {
      conflicts.push({
        type: "existing_ship_id_changed",
        ...compactSourceRow(row),
        ci_ship_id: ship.id,
        ci_ship_name: ship.name,
        current_seg_ship_id: currentSegId
      });
      continue;
    }

    const priorProposal = proposedByShipId.get(String(ship.id));
    if (priorProposal && priorProposal.seg_ship_id !== row.segShipId) {
      conflicts.push({
        type: "multiple_seg_ids_resolve_to_same_ship",
        ...compactSourceRow(row),
        ci_ship_id: ship.id,
        ci_ship_name: ship.name,
        other_seg_ship_id: priorProposal.seg_ship_id
      });
      continue;
    }

    const mapping = {
      id: ship.id,
      seg_ship_id: row.segShipId,
      seg_ship_name: row.shipName,
      seg_cruise_line: row.cruiseLine || null
    };
    proposedByShipId.set(String(ship.id), mapping);
    mappings.push(mapping);
  }

  return { mappings, unmatched, ambiguous, conflicts };
}

async function applyMappings(mappings, sourceIds, seenAt) {
  const result = await supabaseRequest("rpc/apply_seg_ship_sync", {
    method: "POST",
    body: {
      p_mappings: mappings,
      p_source_ids: sourceIds,
      p_seen_at: seenAt
    }
  });
  return result && typeof result === "object" ? result : {};
}

exports.handler = async function handler(event) {
  const startedAt = new Date();
  const sourceUrl = String(process.env.SEG_SHIP_SOURCE_URL || DEFAULT_SEG_SOURCE_URL).trim();
  let run = null;

  try {
    assertAuthorised(event);
    run = await createRun(sourceUrl);

    const [{ csvText, fetchedUrl }, ships, aliases] = await Promise.all([
      fetchSegCsv(),
      listCruiseIntelligenceShips(),
      listShipAliases()
    ]);

    const extracted = extractSegShipRows(csvText);
    const deduped = dedupeSegSourceRows(extracted.rows);
    const sourceIds = [...new Set(deduped.rows.map((row) => row.segShipId))];

    if (deduped.rows.length < MIN_VALID_SOURCE_ROWS || sourceIds.length < MIN_VALID_SOURCE_ROWS) {
      throw new Error(
        `SEG source validation failed: only ${deduped.rows.length} valid rows / ${sourceIds.length} unique ship IDs`
      );
    }

    const reconciliation = buildMappings(deduped.rows, ships, aliases);
    const allConflicts = [...deduped.conflicts, ...reconciliation.conflicts];
    const seenAt = new Date().toISOString();
    const applied = await applyMappings(reconciliation.mappings, sourceIds, seenAt);

    const summary = {
      source_row_count: deduped.rows.length,
      matched_count: reconciliation.mappings.length,
      updated_count: Number(applied.updated_count || reconciliation.mappings.length || 0),
      unmatched_count: reconciliation.unmatched.length,
      ambiguous_count: reconciliation.ambiguous.length,
      conflict_count: allConflicts.length,
      missing_existing_count: Number(applied.missing_existing_count || 0)
    };
    const needsReview = summary.unmatched_count + summary.ambiguous_count + summary.conflict_count > 0;
    const status = needsReview ? "completed_with_review" : "completed";
    const details = {
      fetched_url: fetchedUrl,
      header_row_number: extracted.headerRowNumber,
      headers: extracted.headers,
      detection_method: extracted.detectionMethod || "header",
      invalid_rows: extracted.invalidRows.slice(0, MAX_DETAIL_ROWS),
      duplicate_rows_ignored: deduped.duplicateRows.slice(0, MAX_DETAIL_ROWS).map(compactSourceRow),
      unmatched: reconciliation.unmatched.slice(0, MAX_DETAIL_ROWS),
      ambiguous: reconciliation.ambiguous.slice(0, MAX_DETAIL_ROWS),
      conflicts: allConflicts.slice(0, MAX_DETAIL_ROWS)
    };

    await updateRun(run?.id, {
      ...summary,
      status,
      details,
      completed_at: new Date().toISOString()
    });

    return jsonResponse(200, {
      success: true,
      status,
      source: sourceUrl,
      ...summary,
      elapsed_ms: Date.now() - startedAt.getTime()
    });
  } catch (error) {
    console.error("SEG ship sync failed", { message: error.message });
    if (run?.id) {
      try {
        await updateRun(run.id, {
          status: "failed",
          error_message: String(error.message || "SEG ship sync failed").slice(0, 1000),
          completed_at: new Date().toISOString()
        });
      } catch (logError) {
        console.error("SEG ship sync failure log update failed", { message: logError.message });
      }
    }
    return jsonResponse(error.statusCode || 500, {
      success: false,
      status: "failed",
      error: error.statusCode === 401 ? "UNAUTHORIZED" : "SEG_SHIP_SYNC_FAILED",
      message: error.statusCode === 401 ? "Unauthorized" : String(error.message || "SEG ship sync failed").slice(0, 500),
      elapsed_ms: Date.now() - startedAt.getTime()
    });
  }
};

exports._test = {
  buildMappings,
  isNetlifyPlatformScheduledInvocation
};
