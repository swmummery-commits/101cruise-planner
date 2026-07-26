/**
 * Canonical matching for Brand Imaging folders ↔ ci_cruise_lines / ships.
 * Pure helpers — no I/O.
 */

import {
  softLineKey,
  softShipKey,
  foldKey,
  expandNumericVariants,
  extractYearHint,
  resolveLineFolderAlias
} from "./normalize.js";

export function buildCanonicalIndexes(lines, ships, aliases = []) {
  const linesById = new Map(lines.map((l) => [l.id, l]));
  const shipsById = new Map(ships.map((s) => [s.id, s]));

  const linesBySoft = new Map();
  for (const line of lines) {
    const key = softLineKey(line.name);
    if (!linesBySoft.has(key)) linesBySoft.set(key, []);
    linesBySoft.get(key).push(line);
    const folded = foldKey(line.name);
    if (!linesBySoft.has(folded)) linesBySoft.set(folded, []);
    if (!linesBySoft.get(folded).includes(line)) linesBySoft.get(folded).push(line);
  }

  const shipsByLineSoft = new Map(); // lineId -> Map soft -> ships
  const shipsBySoftGlobal = new Map();

  for (const ship of ships) {
    const key = softShipKey(ship.name);
    const variants = expandNumericVariants(key);
    if (!shipsByLineSoft.has(ship.cruise_line_id)) {
      shipsByLineSoft.set(ship.cruise_line_id, new Map());
    }
    const lineMap = shipsByLineSoft.get(ship.cruise_line_id);
    for (const v of variants) {
      if (!lineMap.has(v)) lineMap.set(v, []);
      lineMap.get(v).push(ship);
      if (!shipsBySoftGlobal.has(v)) shipsBySoftGlobal.set(v, []);
      shipsBySoftGlobal.get(v).push(ship);
    }
  }

  const aliasBySoft = new Map(); // soft alias -> [{ship, alias}]
  for (const a of aliases) {
    if (a.active === false) continue;
    const keys = new Set([
      softShipKey(a.raw_alias || ""),
      foldKey(a.normalised_alias || ""),
      softShipKey(a.normalised_alias || "")
    ]);
    for (const k of keys) {
      if (!k) continue;
      if (!aliasBySoft.has(k)) aliasBySoft.set(k, []);
      aliasBySoft.get(k).push(a);
    }
  }

  return {
    linesById,
    shipsById,
    linesBySoft,
    shipsByLineSoft,
    shipsBySoftGlobal,
    aliasBySoft
  };
}

function uniqueRows(rows) {
  return [...new Map((rows || []).map((r) => [r.id, r])).values()];
}

export function matchCruiseLineFolder(folderName, indexes) {
  const meta = resolveLineFolderAlias(folderName);
  if (meta.kind === "non_line") {
    return {
      status: "non_catalogue_folder",
      folder_name: folderName,
      candidates: []
    };
  }

  const soft = meta.soft_key;
  let hits = indexes.linesBySoft.get(soft) || [];
  if (hits.length === 0) {
    // containment among line soft keys
    const contains = [];
    for (const [key, rows] of indexes.linesBySoft.entries()) {
      if (!soft || !key) continue;
      if (key === soft || key.includes(soft) || soft.includes(key)) {
        contains.push(...rows);
      }
    }
    hits = uniqueRows(contains);
  } else {
    hits = uniqueRows(hits);
  }

  if (hits.length === 1) {
    return {
      status: "exact_canonical_match",
      folder_name: folderName,
      cruise_line_id: hits[0].id,
      cruise_line_name: hits[0].name,
      match_method: soft === softLineKey(hits[0].name) ? "soft_exact" : "soft_contains",
      candidates: hits
    };
  }
  if (hits.length > 1) {
    return {
      status: "ambiguous",
      folder_name: folderName,
      cruise_line_id: null,
      cruise_line_name: null,
      match_method: "ambiguous_line",
      candidates: hits
    };
  }
  return {
    status: "unmatched_local_folder",
    folder_name: folderName,
    cruise_line_id: null,
    cruise_line_name: null,
    match_method: "none",
    candidates: []
  };
}

/**
 * Match a local ship folder to canonical ships.
 */
export function matchShipFolder(shipFolder, lineMatch, indexes) {
  const folderName = shipFolder.folder_name;
  if (shipFolder.parent_line_kind === "non_line" || shipFolder.is_ship_folder === false) {
    return {
      status: "unmatched_local_folder",
      folder_name: folderName,
      parent_line_folder: shipFolder.parent_line_folder,
      reason: "non_ship_or_meta_folder",
      candidates: []
    };
  }

  const soft = softShipKey(folderName);
  const variants = expandNumericVariants(soft);
  const yearHint = extractYearHint(folderName);

  let candidates = [];
  const lineId = lineMatch?.cruise_line_id || null;

  if (lineId && indexes.shipsByLineSoft.has(lineId)) {
    const lineMap = indexes.shipsByLineSoft.get(lineId);
    for (const v of variants) {
      candidates.push(...(lineMap.get(v) || []));
    }
  }

  // Alias lookup constrained to line when possible
  for (const v of variants) {
    for (const alias of indexes.aliasBySoft.get(v) || []) {
      const ship = indexes.shipsById.get(alias.ship_id);
      if (!ship) continue;
      if (lineId && ship.cruise_line_id !== lineId) continue;
      candidates.push(ship);
    }
  }

  candidates = uniqueRows(candidates);

  // If no line-scoped hits, try global soft (may be obsolete / ownership conflict)
  let globalOnly = false;
  if (candidates.length === 0) {
    for (const v of variants) {
      candidates.push(...(indexes.shipsBySoftGlobal.get(v) || []));
      for (const alias of indexes.aliasBySoft.get(v) || []) {
        const ship = indexes.shipsById.get(alias.ship_id);
        if (ship) candidates.push(ship);
      }
    }
    candidates = uniqueRows(candidates);
    globalOnly = candidates.length > 0;
  }

  // Containment / starts-with within line
  if (candidates.length === 0 && lineId) {
    const lineMap = indexes.shipsByLineSoft.get(lineId) || new Map();
    const contains = [];
    for (const [key, rows] of lineMap.entries()) {
      if (!soft || !key) continue;
      if (key.startsWith(soft) || soft.startsWith(key) || key.includes(soft) || soft.includes(key)) {
        // Prefer meaningful token length
        if (Math.min(key.length, soft.length) >= 4) contains.push(...rows);
      }
    }
    candidates = uniqueRows(contains);
  }

  // Year disambiguation when multiple
  if (candidates.length > 1 && yearHint) {
    const yearHits = candidates.filter((s) => String(s.name || "").includes(String(yearHint)));
    if (yearHits.length === 1) candidates = yearHits;
  }

  // Ownership conflict: matched ship(s) not under matched line
  if (
    lineId &&
    candidates.length >= 1 &&
    candidates.every((s) => s.cruise_line_id !== lineId) &&
    globalOnly
  ) {
    return {
      status: "cruise_line_ownership_conflict",
      folder_name: folderName,
      parent_line_folder: shipFolder.parent_line_folder,
      expected_cruise_line_id: lineId,
      expected_cruise_line_name: lineMatch.cruise_line_name,
      candidates: candidates.map((s) => ({
        id: s.id,
        name: s.name,
        cruise_line_id: s.cruise_line_id,
        cruise_line_name: indexes.linesById.get(s.cruise_line_id)?.name || null
      }))
    };
  }

  if (candidates.length === 1) {
    const ship = candidates[0];
    const exactName =
      foldKey(ship.name) === foldKey(folderName) ||
      softShipKey(ship.name) === soft;
    const viaAlias = (indexes.aliasBySoft.get(soft) || []).some(
      (a) => a.ship_id === ship.id
    );
    let status = exactName ? "exact_canonical_match" : "probable_canonical_match";
    if (viaAlias && !exactName) status = "obsolete_former_ship_name";
    // Soft shortenings like "Icon (2024)" → Icon of the Seas are probable
    if (!exactName && softShipKey(ship.name).startsWith(soft)) {
      status = "probable_canonical_match";
    }
    return {
      status,
      folder_name: folderName,
      parent_line_folder: shipFolder.parent_line_folder,
      ship_id: ship.id,
      ship_name: ship.name,
      cruise_line_id: ship.cruise_line_id,
      cruise_line_name: indexes.linesById.get(ship.cruise_line_id)?.name || null,
      match_method: exactName ? "soft_exact" : viaAlias ? "alias" : "soft_probable",
      candidates: [ship]
    };
  }

  if (candidates.length > 1) {
    return {
      status: "ambiguous",
      folder_name: folderName,
      parent_line_folder: shipFolder.parent_line_folder,
      ship_id: null,
      ship_name: null,
      candidates: candidates.map((s) => ({
        id: s.id,
        name: s.name,
        cruise_line_id: s.cruise_line_id
      }))
    };
  }

  return {
    status: "unmatched_local_folder",
    folder_name: folderName,
    parent_line_folder: shipFolder.parent_line_folder,
    ship_id: null,
    ship_name: null,
    candidates: []
  };
}

/**
 * Classify canonical ship coverage against local matches.
 */
export function classifyCanonicalShipCoverage(ship, line, localShipMatches, hasHero) {
  if (hasHero) {
    return {
      coverage: "already_has_canonical_hero",
      ship_id: ship.id,
      ship_name: ship.name,
      cruise_line_id: line?.id || ship.cruise_line_id,
      cruise_line_name: line?.name || null
    };
  }

  const matches = (localShipMatches || []).filter((m) => m.ship_id === ship.id);
  if (matches.length === 0) {
    return {
      coverage: "no_local_match",
      ship_id: ship.id,
      ship_name: ship.name,
      cruise_line_id: line?.id || ship.cruise_line_id,
      cruise_line_name: line?.name || null
    };
  }

  const statuses = new Set(matches.map((m) => m.status));
  if (statuses.has("exact_canonical_match") && matches.length === 1) {
    return {
      coverage: "exact_match",
      ship_id: ship.id,
      ship_name: ship.name,
      local_folders: matches.map((m) => m.folder_name)
    };
  }
  if (
    statuses.has("probable_canonical_match") ||
    statuses.has("obsolete_former_ship_name") ||
    statuses.has("exact_canonical_match")
  ) {
    if (matches.length > 1) {
      return {
        coverage: "ambiguous_match",
        ship_id: ship.id,
        ship_name: ship.name,
        local_folders: matches.map((m) => m.folder_name)
      };
    }
    return {
      coverage: statuses.has("exact_canonical_match") ? "exact_match" : "probable_match",
      ship_id: ship.id,
      ship_name: ship.name,
      local_folders: matches.map((m) => m.folder_name)
    };
  }
  return {
    coverage: "ambiguous_match",
    ship_id: ship.id,
    ship_name: ship.name,
    local_folders: matches.map((m) => m.folder_name)
  };
}
