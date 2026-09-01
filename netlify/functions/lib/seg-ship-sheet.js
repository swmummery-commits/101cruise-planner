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
    .replace(/([a-z])([A-Z])/g, "$1 $2")
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
    [
      "ship id", "shipid", "seg ship id", "seg id", "id", "ship code", "shipcode",
      "ship number", "ship no", "ship identifier", "vessel id", "cruise ship id", "code"
    ],
    ["ship id", "seg id", "vessel id", "ship code", "ship number", "ship identifier"]
  );
  const ship = headerIndex(
    headers,
    [
      "ship name", "ship", "vessel name", "vessel", "cruise ship", "cruise ship name",
      "ship description", "vessel description", "name"
    ],
    ["ship name", "vessel name", "cruise ship", "ship description", "vessel description"]
  );
  const cruiseLine = headerIndex(
    headers,
    [
      "cruise line", "cruise line name", "cruiseline", "line", "brand", "operator",
      "cruise operator", "cruise company", "company"
    ],
    ["cruise line", "cruise operator", "cruise company"]
  );
  return { id, ship, cruiseLine };
}

function looksLikeSegId(value) {
  return /^\d{1,12}$/.test(String(value || "").trim());
}

function columnProfile(table, rowIndex, columnIndex) {
  const values = table
    .slice(rowIndex + 1, rowIndex + 61)
    .map((row) => String(row[columnIndex] || "").trim())
    .filter(Boolean);
  const nonEmpty = values.length;
  if (!nonEmpty) {
    return { columnIndex, nonEmpty: 0, numericRatio: 0, uniqueRatio: 0, textRatio: 0, avgLength: 0 };
  }
  const numeric = values.filter(looksLikeSegId).length;
  const text = values.filter((value) => !looksLikeSegId(value) && /[A-Za-z]/.test(value)).length;
  const unique = new Set(values.map((value) => value.toLowerCase())).size;
  return {
    columnIndex,
    nonEmpty,
    numericRatio: numeric / nonEmpty,
    uniqueRatio: unique / nonEmpty,
    textRatio: text / nonEmpty,
    avgLength: values.reduce((sum, value) => sum + value.length, 0) / nonEmpty
  };
}

function inferHeaderIndexes(table) {
  const searchLimit = Math.min(table.length, 20);
  let best = null;

  for (let rowIndex = 0; rowIndex < searchLimit; rowIndex += 1) {
    const nearby = table.slice(rowIndex, Math.min(table.length, rowIndex + 61));
    const maxColumns = Math.max(0, ...nearby.map((row) => row.length));
    if (maxColumns < 2) continue;

    const profiles = Array.from({ length: maxColumns }, (_, columnIndex) =>
      columnProfile(table, rowIndex, columnIndex)
    );
    const idCandidates = profiles
      .filter((p) => p.nonEmpty >= 10 && p.numericRatio >= 0.8 && p.uniqueRatio >= 0.75)
      .sort((a, b) => (b.numericRatio + b.uniqueRatio) - (a.numericRatio + a.uniqueRatio));
    if (!idCandidates.length) continue;

    const id = idCandidates[0].columnIndex;
    const shipCandidates = profiles
      .filter((p) =>
        p.columnIndex !== id && p.nonEmpty >= 10 && p.textRatio >= 0.75 &&
        p.uniqueRatio >= 0.45 && p.avgLength >= 3 && p.avgLength <= 80
      )
      .sort((a, b) => (b.textRatio * 2 + b.uniqueRatio) - (a.textRatio * 2 + a.uniqueRatio));
    if (!shipCandidates.length) continue;

    const ship = shipCandidates[0].columnIndex;
    const lineCandidates = profiles
      .filter((p) =>
        p.columnIndex !== id && p.columnIndex !== ship && p.nonEmpty >= 10 &&
        p.textRatio >= 0.75 && p.avgLength >= 2 && p.avgLength <= 80
      )
      .sort((a, b) => (b.textRatio + (1 - b.uniqueRatio)) - (a.textRatio + (1 - a.uniqueRatio)));
    const cruiseLine = lineCandidates[0]?.columnIndex ?? -1;

    const headerCells = (table[rowIndex] || []).map(normaliseHeader);
    const headerHint = headerCells.some((value) =>
      ["id", "ship", "vessel", "cruise line", "brand", "operator", "code", "ship code", "vessel code"].includes(value) ||
      /^(seg )?ship (id|code|number|name|description)$/.test(value) ||
      /^cruise (line|ship|operator|company)/.test(value)
    ) ? 1 : 0;
    const score = idCandidates[0].numericRatio * 3 + idCandidates[0].uniqueRatio * 2 +
      shipCandidates[0].textRatio * 2 + shipCandidates[0].uniqueRatio * 2 + headerHint - rowIndex * 0.01;

    if (!best || score > best.score) {
      best = { rowIndex, headers: table[rowIndex], indexes: { id, ship, cruiseLine }, score };
    }
  }

  return best;
}

function findHeaderRow(table) {
  const searchLimit = Math.min(table.length, 20);
  for (let i = 0; i < searchLimit; i += 1) {
    const indexes = resolveSegHeaderIndexes(table[i]);
    if (indexes.id >= 0 && indexes.ship >= 0) {
      return { rowIndex: i, headers: table[i], indexes, detectionMethod: "header" };
    }
  }

  const inferred = inferHeaderIndexes(table);
  if (inferred) return { ...inferred, detectionMethod: "inferred" };

  const error = new Error("SEG sheet does not contain recognisable Ship ID and Ship Name columns");
  error.code = "SEG_HEADER_NOT_RECOGNISED";
  error.preview = table.slice(0, 5).map((row) => row.map((cell) => String(cell || "").trim()).slice(0, 8));
  throw error;
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
    if (!segShipId || !shipName || !looksLikeSegId(segShipId)) {
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
    headerRowNumber: header.rowIndex + 1,
    detectionMethod: header.detectionMethod
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
  inferHeaderIndexes,
  extractSegShipRows,
  dedupeSegSourceRows
};
