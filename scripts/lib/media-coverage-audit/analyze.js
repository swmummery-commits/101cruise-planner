/**
 * Pure Cruise Media Coverage analysis helpers (no network, no I/O).
 */

import { classifyHost } from "../squarespace-ci-media/url-safety.js";

export function mediaStatusFromUrl(url) {
  const host = classifyHost(url);
  if (host === "blank") return "missing";
  if (host === "squarespace") return "squarespace";
  if (host === "supabase") return "supabase";
  return "other_external";
}

export function yesNo(value) {
  return value ? "yes" : "no";
}

export function reachableLabel(url, reachable) {
  if (!url || !String(url).trim()) return "not_applicable";
  if (reachable === true) return "yes";
  if (reachable === false) return "no";
  return "not_applicable";
}

/**
 * Media Library rows owned by a cruise line logo (no ship).
 */
export function lineLogoMediaRows(mediaRows, lineId) {
  return (mediaRows || []).filter(
    (m) => String(m.cruise_line_id) === String(lineId) && !m.ship_id
  );
}

/**
 * Media Library rows owned by a ship.
 */
export function shipHeroMediaRows(mediaRows, shipId) {
  return (mediaRows || []).filter((m) => String(m.ship_id) === String(shipId));
}

/**
 * Pick the best matching Media Library row for a canonical URL.
 */
export function pickMatchingMedia(rows, canonicalUrl) {
  const list = rows || [];
  if (!list.length) return null;
  const url = String(canonicalUrl || "").trim();
  if (url) {
    const exact = list.find((m) => String(m.public_url || "").trim() === url);
    if (exact) return exact;
    const bySource = list.find((m) => String(m.source_url || "").trim() === url);
    if (bySource) return bySource;
  }
  if (list.length === 1) return list[0];
  return null;
}

export function relationshipCorrectForLine(mediaRow) {
  if (!mediaRow) return true;
  return !mediaRow.ship_id;
}

export function relationshipCorrectForShip(mediaRow, ship, lineId) {
  if (!mediaRow) return true;
  if (String(mediaRow.ship_id) !== String(ship.id)) return false;
  if (
    mediaRow.cruise_line_id != null &&
    String(mediaRow.cruise_line_id) !== String(lineId)
  ) {
    return false;
  }
  return true;
}

/**
 * Index content_hash → entities for shared-binary review.
 */
export function indexContentHashes(mediaRows) {
  const byHash = new Map();
  for (const m of mediaRows || []) {
    const hash = m.content_hash ? String(m.content_hash) : "";
    if (!hash) continue;
    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push(m);
  }
  return byHash;
}

export function sharedBinaryGroups(byHash) {
  const groups = [];
  for (const [hash, rows] of byHash.entries()) {
    const entities = new Set(
      rows.map((r) =>
        r.ship_id ? `ship:${r.ship_id}` : `line:${r.cruise_line_id || "none"}`
      )
    );
    if (entities.size > 1) {
      groups.push({
        content_hash: hash,
        entity_count: entities.size,
        media_library_ids: rows.map((r) => r.id),
        entities: [...entities]
      });
    }
  }
  return groups;
}

/**
 * Build line coverage row (reachable supplied by caller).
 */
export function analyseCruiseLine({ line, mediaRows, reachable }) {
  const url = line.logo_url || null;
  const status = mediaStatusFromUrl(url);
  const owned = lineLogoMediaRows(mediaRows, line.id);
  const match = pickMatchingMedia(owned, url);
  const anomalies = [];

  if (status === "missing") anomalies.push("missing_logo");
  if (status === "squarespace") anomalies.push("remaining_squarespace_url");
  if (status === "other_external") anomalies.push("other_external_logo");
  if (status === "supabase" && !match) {
    anomalies.push("supabase_url_without_media_library");
  }
  if (match && url && String(match.public_url || "").trim() !== String(url).trim()) {
    anomalies.push("media_library_public_url_mismatch");
  }
  if (match && !relationshipCorrectForLine(match)) {
    anomalies.push("incorrect_media_relationship");
  }
  if (owned.length > 1) anomalies.push("duplicate_media_library_rows");
  if (reachable === false) anomalies.push("broken_url");

  const hashDupes = countDuplicateHashes(owned);
  if (hashDupes > 0) anomalies.push("duplicate_content_hash_same_entity");

  return {
    uuid: line.id,
    canonical_name: line.name,
    active: line.active == null ? "" : Boolean(line.active),
    logo_url: url || "",
    logo_status: status,
    url_reachable: reachableLabel(url, reachable),
    matching_media_library: yesNo(Boolean(match)),
    matching_media_library_uuid: match?.id || "",
    source_url: match?.source_url || "",
    content_hash_present: yesNo(Boolean(match?.content_hash)),
    storage_path: match?.storage_path || "",
    relationship_correct: yesNo(relationshipCorrectForLine(match)),
    duplicate_media_library_records: owned.length > 1 ? owned.length : 0,
    anomalies: anomalies.join("; ")
  };
}

export function analyseShip({ ship, lineName, mediaRows, reachable }) {
  const url = ship.hero_image_url || null;
  const status = mediaStatusFromUrl(url);
  const owned = shipHeroMediaRows(mediaRows, ship.id);
  const match = pickMatchingMedia(owned, url);
  const anomalies = [];

  if (status === "missing") anomalies.push("missing_hero");
  if (status === "squarespace") anomalies.push("remaining_squarespace_url");
  if (status === "other_external") anomalies.push("other_external_hero");
  if (status === "supabase" && !match) {
    anomalies.push("supabase_url_without_media_library");
  }
  if (match && url && String(match.public_url || "").trim() !== String(url).trim()) {
    anomalies.push("media_library_public_url_mismatch");
  }
  if (match && !relationshipCorrectForShip(match, ship, ship.cruise_line_id)) {
    anomalies.push("incorrect_media_relationship");
  }
  if (owned.length > 1) anomalies.push("duplicate_media_library_rows");
  if (reachable === false) anomalies.push("broken_url");

  const hashDupes = countDuplicateHashes(owned);
  if (hashDupes > 0) anomalies.push("duplicate_content_hash_same_entity");

  return {
    uuid: ship.id,
    canonical_ship_name: ship.name,
    cruise_line_uuid: ship.cruise_line_id,
    cruise_line_name: lineName || "",
    active: ship.active == null ? "" : Boolean(ship.active),
    hero_image_url: url || "",
    hero_status: status,
    url_reachable: reachableLabel(url, reachable),
    matching_media_library: yesNo(Boolean(match)),
    matching_media_library_uuid: match?.id || "",
    source_url: match?.source_url || "",
    content_hash_present: yesNo(Boolean(match?.content_hash)),
    storage_path: match?.storage_path || "",
    relationship_correct: yesNo(
      relationshipCorrectForShip(match, ship, ship.cruise_line_id)
    ),
    duplicate_media_library_records: owned.length > 1 ? owned.length : 0,
    anomalies: anomalies.join("; ")
  };
}

function countDuplicateHashes(rows) {
  const counts = new Map();
  for (const r of rows || []) {
    if (!r.content_hash) continue;
    const k = String(r.content_hash);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let dupes = 0;
  for (const n of counts.values()) {
    if (n > 1) dupes += n;
  }
  return dupes;
}

/**
 * Catalogue-level anomalies (orphans, bad links, shared binaries for review).
 */
export function collectCatalogueAnomalies({
  lines,
  ships,
  mediaRows,
  lineRows,
  shipRows,
  sharedBinaries,
  storageOrphans
}) {
  const anomalies = [];
  const lineIds = new Set((lines || []).map((l) => String(l.id)));
  const shipIds = new Set((ships || []).map((s) => String(s.id)));
  const shipsById = new Map((ships || []).map((s) => [String(s.id), s]));

  for (const m of mediaRows || []) {
    if (m.cruise_line_id && !lineIds.has(String(m.cruise_line_id))) {
      anomalies.push({
        category: "orphan_media_library_line",
        severity: "error",
        entity_type: "media_library",
        entity_id: m.id,
        detail: `media_library.cruise_line_id ${m.cruise_line_id} not in ci_cruise_lines`
      });
    }
    if (m.ship_id && !shipIds.has(String(m.ship_id))) {
      anomalies.push({
        category: "orphan_media_library_ship",
        severity: "error",
        entity_type: "media_library",
        entity_id: m.id,
        detail: `media_library.ship_id ${m.ship_id} not in ci_cruise_ships`
      });
    }
    if (m.ship_id) {
      const ship = shipsById.get(String(m.ship_id));
      if (
        ship &&
        m.cruise_line_id != null &&
        String(m.cruise_line_id) !== String(ship.cruise_line_id)
      ) {
        anomalies.push({
          category: "incorrect_media_relationship",
          severity: "error",
          entity_type: "media_library",
          entity_id: m.id,
          detail: `media cruise_line_id ${m.cruise_line_id} != ship.cruise_line_id ${ship.cruise_line_id}`
        });
      }
    }
  }

  for (const row of lineRows || []) {
    if (!row.anomalies) continue;
    for (const code of String(row.anomalies).split(";").map((s) => s.trim()).filter(Boolean)) {
      anomalies.push({
        category: code,
        severity: code.includes("broken") || code.includes("incorrect") ? "error" : "warning",
        entity_type: "cruise_line",
        entity_id: row.uuid,
        detail: `${row.canonical_name}: ${code}`
      });
    }
  }
  for (const row of shipRows || []) {
    if (!row.anomalies) continue;
    for (const code of String(row.anomalies).split(";").map((s) => s.trim()).filter(Boolean)) {
      anomalies.push({
        category: code,
        severity: code.includes("broken") || code.includes("incorrect") ? "error" : "warning",
        entity_type: "ship",
        entity_id: row.uuid,
        detail: `${row.canonical_ship_name}: ${code}`
      });
    }
  }

  for (const g of sharedBinaries || []) {
    anomalies.push({
      category: "shared_binary_review",
      severity: "info",
      entity_type: "content_hash",
      entity_id: g.content_hash,
      detail: `content_hash shared by ${g.entity_count} entities (not automatic error)`
    });
  }

  for (const o of storageOrphans || []) {
    anomalies.push({
      category: "orphaned_storage_reference",
      severity: "warning",
      entity_type: "media_library",
      entity_id: o.media_library_id,
      detail: o.detail
    });
  }

  return anomalies;
}

export function summariseCoverage({ lineRows, shipRows, anomalies, sharedBinaries }) {
  const lines = lineRows || [];
  const ships = shipRows || [];
  const countStatus = (rows, key, value) =>
    rows.filter((r) => r[key] === value).length;

  const remainingSquarespace =
    countStatus(lines, "logo_status", "squarespace") +
    countStatus(ships, "hero_status", "squarespace");

  const brokenUrls =
    lines.filter((r) => r.url_reachable === "no").length +
    ships.filter((r) => r.url_reachable === "no").length;

  const relationshipErrors = (anomalies || []).filter(
    (a) => a.category === "incorrect_media_relationship"
  ).length;

  const duplicateWarnings = (anomalies || []).filter(
    (a) =>
      a.category === "duplicate_media_library_rows" ||
      a.category === "duplicate_content_hash_same_entity"
  ).length;

  const orphanWarnings = (anomalies || []).filter((a) =>
    String(a.category).startsWith("orphan")
  ).length;

  const storageOrphanWarnings = (anomalies || []).filter(
    (a) => a.category === "orphaned_storage_reference"
  ).length;

  return {
    total_cruise_lines: lines.length,
    lines_with_supabase_logos: countStatus(lines, "logo_status", "supabase"),
    lines_with_squarespace_logos: countStatus(lines, "logo_status", "squarespace"),
    lines_with_other_external_logos: countStatus(lines, "logo_status", "other_external"),
    lines_with_missing_logos: countStatus(lines, "logo_status", "missing"),
    total_ships: ships.length,
    ships_with_supabase_heroes: countStatus(ships, "hero_status", "supabase"),
    ships_with_squarespace_heroes: countStatus(ships, "hero_status", "squarespace"),
    ships_with_other_external_heroes: countStatus(ships, "hero_status", "other_external"),
    ships_with_missing_heroes: countStatus(ships, "hero_status", "missing"),
    remaining_squarespace_urls: remainingSquarespace,
    broken_urls: brokenUrls,
    relationship_errors: relationshipErrors,
    duplicate_record_warnings: duplicateWarnings,
    orphan_warnings: orphanWarnings + storageOrphanWarnings,
    shared_binary_review_count: (sharedBinaries || []).length,
    total_anomalies: (anomalies || []).length,
    writes: {
      insert: 0,
      update: 0,
      delete: 0,
      storage_writes: 0,
      dev_writes: 0
    }
  };
}

export function toCsv(rows, columns) {
  const escape = (v) => {
    const s = v == null ? "" : String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const header = columns.join(",");
  const body = (rows || []).map((row) =>
    columns.map((c) => escape(row[c])).join(",")
  );
  return [header, ...body].join("\n") + "\n";
}

export const LINE_CSV_COLUMNS = Object.freeze([
  "uuid",
  "canonical_name",
  "active",
  "logo_url",
  "logo_status",
  "url_reachable",
  "matching_media_library",
  "matching_media_library_uuid",
  "source_url",
  "content_hash_present",
  "storage_path",
  "relationship_correct",
  "duplicate_media_library_records",
  "anomalies"
]);

export const SHIP_CSV_COLUMNS = Object.freeze([
  "uuid",
  "canonical_ship_name",
  "cruise_line_uuid",
  "cruise_line_name",
  "active",
  "hero_image_url",
  "hero_status",
  "url_reachable",
  "matching_media_library",
  "matching_media_library_uuid",
  "source_url",
  "content_hash_present",
  "storage_path",
  "relationship_correct",
  "duplicate_media_library_records",
  "anomalies"
]);

export const ANOMALY_CSV_COLUMNS = Object.freeze([
  "category",
  "severity",
  "entity_type",
  "entity_id",
  "detail"
]);
