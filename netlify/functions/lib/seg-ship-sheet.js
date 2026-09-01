"use strict";

const DEFAULT_SEG_SHEET_ID = "1hDh2iUfC9VQZSRGf61MFqS-JDjFmihnf7Xx6897UIFY";
const DEFAULT_SEG_SHEET_GID = "0";
const DEFAULT_SEG_SOURCE_URL = `https://docs.google.com/spreadsheets/d/${DEFAULT_SEG_SHEET_ID}/edit?gid=${DEFAULT_SEG_SHEET_GID}#gid=${DEFAULT_SEG_SHEET_GID}`;

function buildSheetCsvUrls(options = {}) {
  const sheetId = String(options.sheetId || DEFAULT_SEG_SHEET_ID).trim();
  const gid = String(options.gid ?? DEFAULT_SEG_SHEET_GID).trim() || DEFAULT_SEG_SHEET_GID;
  return [
    `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/export?format=csv&gid=${encodeURIComponent(gid)}`,
    `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?tqx=out:csv&gid=${encodeURIComponent(gid)}`
  ];
}

function parseCsv(text) {
  const input = String(text || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (quoted) throw new Error("SEG CSV contains an unterminated quoted field");
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => String(cell || "").trim() !== ""));
}

function normaliseHeader(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function headerIndex(headers, exactCandidates, containsCandidates = []) {
  const normalised = headers.map(normaliseHeader);
  for (const candidate of exactCandidates) {
    const idx = normalised.indexOf(candidate);
    if (idx >= 0) return idx;
  }
  for (let i = 0; i < normalised.length; i += 1) {
    if (containsCandidates.some((candidate) => normalised[i].includes(candidate))) return i;
  }
  return -1;
}

function resolveSegHeaderIndexes(headers) {
  const id = headerIndex(
    headers,
    ["ship id", "shipid", "seg ship id", "seg id"],
    ["ship id", "seg id"]
  );
  const ship = headerIndex(
    headers,
    ["ship name", "ship", "vessel name", "vessel"],
    ["ship name", "vessel name"]
  );
  const cruiseLine = headerIndex(
    headers,
    ["cruise line", "cruise line name", "cruiseline", "line", "brand"],
    ["cruise line"]
  );
  return { id, ship, cruiseLine };
}

function findHeaderRow(table) {
  const searchLimit = Math.min(table.length, 20);
  for (let i = 0; i < searchLimit; i += 1) {
    const indexes = resolveSegHeaderIndexes(table[i]);
    if (indexes.id >= 0 && indexes.ship >= 0) {
      return { rowIndex: i, headers: table[i], indexes };
    }
  }
  throw new Error("SEG sheet does not contain recognisable Ship ID and Ship Name columns");
}

function sourceRowKey(row) {
  return `${String(row.shipName || "").trim().toLowerCase()}|${String(row.cruiseLine || "").trim().toLowerCase()}`;
}

function extractSegShipRows(csvText) {
  const table = parseCsv(csvText);
  if (!table.length) throw new Error("SEG sheet returned an empty CSV");

  const header = findHeaderRow(table);
  const rows = [];
  const invalidRows = [];

  for (let i = header.rowIndex + 1; i < table.length; i += 1) {
    const cells = table[i];
    const segShipId = String(cells[header.indexes.id] || "").trim();
    const shipName = String(cells[header.indexes.ship] || "").trim();
    const cruiseLine = header.indexes.cruiseLine >= 0
      ? String(cells[header.indexes.cruiseLine] || "").trim()
      : "";

    if (!segShipId && !shipName && !cruiseLine) continue;
    if (!segShipId || !shipName || !/^\d+$/.test(segShipId)) {
      invalidRows.push({
        row_number: i + 1,
        seg_ship_id: segShipId || null,
        ship_name: shipName || null,
        cruise_line: cruiseLine || null
      });
      continue;
    }

    rows.push({
      segShipId,
      shipName,
      cruiseLine,
      sourceRowNumber: i + 1
    });
  }

  return {
    headers: header.headers.map((value) => String(value || "").trim()),
    rows,
    invalidRows,
    headerRowNumber: header.rowIndex + 1
  };
}

function dedupeSegSourceRows(rows) {
  const byId = new Map();
  const uniqueRows = [];
  const duplicateRows = [];
  const conflicts = [];

  for (const row of rows || []) {
    const existing = byId.get(row.segShipId);
    if (!existing) {
      byId.set(row.segShipId, row);
      uniqueRows.push(row);
      continue;
    }
    if (sourceRowKey(existing) === sourceRowKey(row)) {
      duplicateRows.push(row);
      continue;
    }
    conflicts.push({
      type: "duplicate_seg_id_in_source",
      seg_ship_id: row.segShipId,
      first: {
        ship_name: existing.shipName,
        cruise_line: existing.cruiseLine,
        row_number: existing.sourceRowNumber
      },
      second: {
        ship_name: row.shipName,
        cruise_line: row.cruiseLine,
        row_number: row.sourceRowNumber
      }
    });
  }

  const conflictedIds = new Set(conflicts.map((item) => item.seg_ship_id));
  return {
    rows: uniqueRows.filter((row) => !conflictedIds.has(row.segShipId)),
    duplicateRows,
    conflicts
  };
}

module.exports = {
  DEFAULT_SEG_SHEET_ID,
  DEFAULT_SEG_SHEET_GID,
  DEFAULT_SEG_SOURCE_URL,
  buildSheetCsvUrls,
  parseCsv,
  normaliseHeader,
  resolveSegHeaderIndexes,
  extractSegShipRows,
  dedupeSegSourceRows
};
