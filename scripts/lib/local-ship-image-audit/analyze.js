/**
 * Aggregate Brand Imaging scan + canonical catalogue into audit reports.
 * Pure analysis — callers perform read-only I/O.
 */

import {
  buildCanonicalIndexes,
  matchCruiseLineFolder,
  matchShipFolder,
  classifyCanonicalShipCoverage
} from "./match.js";
import { scoreHeroCandidate, recommendFromCandidates } from "./classify.js";

export function toCsv(rows, columns) {
  const esc = (v) => {
    if (v == null) return "";
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const header = columns.join(",");
  const body = (rows || [])
    .map((row) => columns.map((c) => esc(row[c])).join(","))
    .join("\n");
  return `${header}\n${body}${body ? "\n" : ""}`;
}

export const COVERAGE_CSV_COLUMNS = [
  "ship_id",
  "ship_name",
  "cruise_line_id",
  "cruise_line_name",
  "has_canonical_hero",
  "coverage_class",
  "local_ship_folders",
  "local_image_count",
  "exterior_candidate_count",
  "suitable_hero_count",
  "recommendation",
  "top_candidate_path",
  "top_candidate_score"
];

export const FOLDER_MATCH_CSV_COLUMNS = [
  "local_line_folder",
  "local_ship_folder",
  "folder_status",
  "match_method",
  "canonical_ship_id",
  "canonical_ship_name",
  "canonical_cruise_line_id",
  "canonical_cruise_line_name",
  "candidate_count",
  "candidate_names"
];

export const HERO_CANDIDATE_CSV_COLUMNS = [
  "ship_id",
  "ship_name",
  "cruise_line_name",
  "has_canonical_hero",
  "recommendation",
  "rank",
  "score",
  "suitable",
  "apparent_role",
  "width",
  "height",
  "aspect_ratio",
  "file_size_bytes",
  "absolute_path",
  "content_hash",
  "score_reasons"
];

export const ANOMALY_CSV_COLUMNS = [
  "anomaly_type",
  "severity",
  "detail",
  "path_or_id",
  "related"
];

function hasHeroUrl(url) {
  return Boolean(url && String(url).trim());
}

/**
 * Full audit analysis from injectable scan + catalogue snapshots.
 */
export function analyseLocalShipImageCoverage({
  scan,
  lines,
  ships,
  aliases = []
}) {
  const indexes = buildCanonicalIndexes(lines, ships, aliases);
  const linesById = indexes.linesById;

  // Match line folders
  const lineFolderMatches = [];
  for (const lf of scan.line_folders || []) {
    if (lf.kind === "non_line") {
      lineFolderMatches.push({
        folder_name: lf.folder_name,
        status: "non_catalogue_folder",
        cruise_line_id: null,
        cruise_line_name: null
      });
      continue;
    }
    lineFolderMatches.push(matchCruiseLineFolder(lf.folder_name, indexes));
  }
  const lineMatchByFolder = new Map(
    lineFolderMatches.map((m) => [m.folder_name, m])
  );

  // Match ship folders
  const shipFolderMatches = [];
  for (const sf of scan.ship_folders || []) {
    if (!sf.is_ship_folder) continue;
    const lineMatch = lineMatchByFolder.get(sf.parent_line_folder) || {
      status: "unmatched_local_folder",
      cruise_line_id: null
    };
    shipFolderMatches.push(matchShipFolder(sf, lineMatch, indexes));
  }

  // Index images by ship folder
  const imagesByShipFolder = new Map();
  for (const img of scan.images || []) {
    if (!img.parent_ship_folder) continue;
    const key = `${img.parent_cruise_line_folder}::${img.parent_ship_folder}`;
    if (!imagesByShipFolder.has(key)) imagesByShipFolder.set(key, []);
    imagesByShipFolder.get(key).push(img);
  }

  // Map ship_id -> matched local folders
  const matchesByShipId = new Map();
  for (const m of shipFolderMatches) {
    if (!m.ship_id) continue;
    if (!matchesByShipId.has(m.ship_id)) matchesByShipId.set(m.ship_id, []);
    matchesByShipId.get(m.ship_id).push(m);
  }

  // Duplicate hash groups
  const byHash = new Map();
  for (const img of scan.images || []) {
    if (!img.content_hash) continue;
    if (!byHash.has(img.content_hash)) byHash.set(img.content_hash, []);
    byHash.get(img.content_hash).push(img);
  }
  const duplicateGroups = [...byHash.entries()]
    .filter(([, arr]) => arr.length > 1)
    .map(([hash, arr]) => ({
      content_hash: hash,
      count: arr.length,
      paths: arr.map((i) => i.absolute_path),
      ship_folders: [
        ...new Set(
          arr
            .map((i) =>
              i.parent_ship_folder
                ? `${i.parent_cruise_line_folder}/${i.parent_ship_folder}`
                : i.parent_cruise_line_folder || "(root)"
            )
        )
      ],
      cross_ship_folder: new Set(
        arr.map((i) => `${i.parent_cruise_line_folder}::${i.parent_ship_folder}`)
      ).size > 1
    }));

  const crossShipDuplicates = duplicateGroups.filter((g) => g.cross_ship_folder);
  const fleetReuseForReview = crossShipDuplicates.map((g) => ({
    type: "fleet_level_or_cross_folder_reuse",
    content_hash: g.content_hash,
    paths: g.paths,
    ship_folders: g.ship_folders
  }));

  const cloudPlaceholders = (scan.images || []).filter(
    (i) => i.inspect_error === "icloud_placeholder_not_downloaded"
  );
  const corruptFiles = (scan.images || []).filter(
    (i) =>
      i.opens_successfully === false &&
      i.inspect_error !== "icloud_placeholder_not_downloaded"
  );
  const lowRes = (scan.images || []).filter((i) => {
    const longSide = Math.max(i.width || 0, i.height || 0);
    return i.opens_successfully && longSide > 0 && longSide < 800;
  });

  // Per canonical ship coverage + hero candidates
  const coverageRows = [];
  const heroCandidateRows = [];
  const anomalies = [];

  let exactMatches = 0;
  let probableMatches = 0;
  let ambiguousMatches = 0;
  let noLocalMatchMissingHero = 0;
  let alreadyHasHeroWithLocal = 0;
  let missingWithSuitable = 0;
  let clearSingle = 0;
  let steveSelection = 0;
  let preferredWithAlts = 0;
  let noSuitable = 0;
  let portraitOnlySets = 0;
  let shipFoldersNoExterior = 0;

  for (const ship of ships) {
    const line = linesById.get(ship.cruise_line_id);
    const hasHero = hasHeroUrl(ship.hero_image_url);
    const localMatches = matchesByShipId.get(ship.id) || [];
    const coverage = classifyCanonicalShipCoverage(ship, line, localMatches, hasHero);

    // Collect images from matched folders
    const folderImages = [];
    for (const m of localMatches) {
      const key = `${m.parent_line_folder}::${m.folder_name}`;
      folderImages.push(...(imagesByShipFolder.get(key) || []));
    }

    const scored = folderImages.map((img) => {
      const { score, reasons, suitable } = scoreHeroCandidate(img);
      return { ...img, score, score_reasons: reasons.join("|"), suitable };
    });
    scored.sort((a, b) => b.score - a.score);

    const exteriorCandidates = scored.filter(
      (s) => s.apparent_role === "exterior_ship_hero" || (s.suitable && s.apparent_role === "unknown")
    );
    const suitable = scored.filter((s) => s.suitable);
    const rec = hasHero
      ? { recommendation: "already_has_canonical_hero", top: null, alternatives: [] }
      : recommendFromCandidates(scored);

    if (coverage.coverage === "exact_match") exactMatches += 1;
    if (coverage.coverage === "probable_match") probableMatches += 1;
    if (coverage.coverage === "ambiguous_match") ambiguousMatches += 1;
    if (coverage.coverage === "no_local_match" && !hasHero) noLocalMatchMissingHero += 1;
    if (hasHero && folderImages.length > 0) alreadyHasHeroWithLocal += 1;

    if (!hasHero && localMatches.length > 0) {
      if (suitable.length > 0) missingWithSuitable += 1;
      if (rec.recommendation === "clear_single_candidate") clearSingle += 1;
      else if (rec.recommendation === "Steve_selection_required") steveSelection += 1;
      else if (rec.recommendation === "preferred_candidate_with_alternatives") {
        preferredWithAlts += 1;
      } else if (rec.recommendation === "no_suitable_hero") noSuitable += 1;

      const landscapes = folderImages.filter((i) => (i.width || 0) >= (i.height || 0));
      if (folderImages.length > 0 && landscapes.length === 0) portraitOnlySets += 1;
      const exteriors = folderImages.filter((i) => i.apparent_role === "exterior_ship_hero");
      if (folderImages.length > 0 && exteriors.length === 0) shipFoldersNoExterior += 1;
    }

    coverageRows.push({
      ship_id: ship.id,
      ship_name: ship.name,
      cruise_line_id: ship.cruise_line_id,
      cruise_line_name: line?.name || "",
      has_canonical_hero: hasHero,
      coverage_class: coverage.coverage,
      local_ship_folders: localMatches.map((m) => m.folder_name).join(" | "),
      local_image_count: folderImages.length,
      exterior_candidate_count: exteriorCandidates.length,
      suitable_hero_count: suitable.length,
      recommendation: rec.recommendation,
      top_candidate_path: rec.top?.absolute_path || "",
      top_candidate_score: rec.top?.score ?? ""
    });

    if (!hasHero && localMatches.length > 0) {
      let rank = 0;
      for (const c of scored.filter((s) => s.suitable || s.apparent_role === "exterior_ship_hero")) {
        rank += 1;
        heroCandidateRows.push({
          ship_id: ship.id,
          ship_name: ship.name,
          cruise_line_name: line?.name || "",
          has_canonical_hero: false,
          recommendation: rec.recommendation,
          rank,
          score: c.score,
          suitable: c.suitable,
          apparent_role: c.apparent_role,
          width: c.width,
          height: c.height,
          aspect_ratio: c.aspect_ratio,
          file_size_bytes: c.file_size_bytes,
          absolute_path: c.absolute_path,
          content_hash: c.content_hash,
          score_reasons: c.score_reasons
        });
      }
    }

    if (hasHero && folderImages.length > 0) {
      anomalies.push({
        anomaly_type: "local_assets_for_ship_with_canonical_hero",
        severity: "info",
        detail: `${folderImages.length} local image(s) for ship that already has hero_image_url`,
        path_or_id: ship.id,
        related: ship.name
      });
    }
  }

  // Folder-level CSV
  const folderMatchRows = shipFolderMatches.map((m) => ({
    local_line_folder: m.parent_line_folder || "",
    local_ship_folder: m.folder_name,
    folder_status: m.status,
    match_method: m.match_method || "",
    canonical_ship_id: m.ship_id || "",
    canonical_ship_name: m.ship_name || "",
    canonical_cruise_line_id: m.cruise_line_id || m.expected_cruise_line_id || "",
    canonical_cruise_line_name: m.cruise_line_name || m.expected_cruise_line_name || "",
    candidate_count: (m.candidates || []).length,
    candidate_names: (m.candidates || [])
      .map((c) => c.name || c.ship_name || "")
      .filter(Boolean)
      .join(" | ")
  }));

  // Anomalies continued
  for (const m of shipFolderMatches) {
    if (m.status === "cruise_line_ownership_conflict") {
      anomalies.push({
        anomaly_type: "ownership_conflict",
        severity: "high",
        detail: `Local folder under ${m.parent_line_folder} matched ship(s) on another line`,
        path_or_id: `${m.parent_line_folder}/${m.folder_name}`,
        related: (m.candidates || []).map((c) => c.name).join(" | ")
      });
    }
    if (m.status === "ambiguous") {
      anomalies.push({
        anomaly_type: "ambiguous_ship_folder",
        severity: "medium",
        detail: "Multiple canonical ships matched",
        path_or_id: `${m.parent_line_folder}/${m.folder_name}`,
        related: (m.candidates || []).map((c) => c.name).join(" | ")
      });
    }
    if (m.status === "unmatched_local_folder") {
      anomalies.push({
        anomaly_type: "unmatched_local_ship_folder",
        severity: "medium",
        detail: "No canonical ship match",
        path_or_id: `${m.parent_line_folder}/${m.folder_name}`,
        related: ""
      });
    }
  }

  for (const lm of lineFolderMatches) {
    if (lm.status === "unmatched_local_folder") {
      anomalies.push({
        anomaly_type: "cruise_line_folder_not_in_catalogue",
        severity: "medium",
        detail: "Local cruise-line folder not represented in canonical catalogue",
        path_or_id: lm.folder_name,
        related: ""
      });
    }
  }

  for (const f of cloudPlaceholders) {
    anomalies.push({
      anomaly_type: "icloud_placeholder_not_downloaded",
      severity: "medium",
      detail:
        "File is an iCloud placeholder (not local). Audit skipped content read to avoid download.",
      path_or_id: f.absolute_path,
      related: String(f.file_size_bytes || "")
    });
  }

  for (const f of corruptFiles) {
    anomalies.push({
      anomaly_type: "corrupt_or_unreadable",
      severity: "high",
      detail: f.inspect_error || "unreadable",
      path_or_id: f.absolute_path,
      related: ""
    });
  }

  for (const f of lowRes) {
    anomalies.push({
      anomaly_type: "low_resolution",
      severity: "low",
      detail: `${f.width}x${f.height}`,
      path_or_id: f.absolute_path,
      related: ""
    });
  }

  for (const g of duplicateGroups) {
    anomalies.push({
      anomaly_type: g.cross_ship_folder
        ? "byte_identical_across_ship_folders"
        : "byte_identical_duplicates",
      severity: g.cross_ship_folder ? "medium" : "low",
      detail: `${g.count} copies; folders: ${g.ship_folders.join(" | ")}`,
      path_or_id: g.content_hash,
      related: g.paths[0] || ""
    });
  }

  for (const g of fleetReuseForReview) {
    anomalies.push({
      anomaly_type: "fleet_level_image_reuse_for_review",
      severity: "info",
      detail: "Identical binary under multiple ship folders (may be legitimate fleet reuse)",
      path_or_id: g.content_hash,
      related: g.ship_folders.join(" | ")
    });
  }

  const watermarky = (scan.images || []).filter((i) =>
    /\b(watermark|shutterstock|getty|istock|alamy)\b/i.test(i.filename || "")
  );
  for (const f of watermarky) {
    anomalies.push({
      anomaly_type: "possible_stock_watermark_filename",
      severity: "medium",
      detail: "Filename suggests stock/watermark source",
      path_or_id: f.absolute_path,
      related: f.filename
    });
  }

  const textOverlay = (scan.images || []).filter((i) =>
    /\b(overlay|text|collage|montage)\b/i.test(i.filename || "")
  );
  for (const f of textOverlay) {
    anomalies.push({
      anomaly_type: "possible_text_overlay_filename",
      severity: "low",
      detail: "Filename suggests text overlay/graphic",
      path_or_id: f.absolute_path,
      related: f.filename
    });
  }

  const unmatchedShipFolders = shipFolderMatches.filter(
    (m) => m.status === "unmatched_local_folder"
  ).length;
  const ownershipConflicts = shipFolderMatches.filter(
    (m) => m.status === "cruise_line_ownership_conflict"
  ).length;
  const ambiguousFolders = shipFolderMatches.filter((m) => m.status === "ambiguous").length;
  const exactFolderMatches = shipFolderMatches.filter(
    (m) => m.status === "exact_canonical_match"
  ).length;
  const probableFolderMatches = shipFolderMatches.filter(
    (m) =>
      m.status === "probable_canonical_match" || m.status === "obsolete_former_ship_name"
  ).length;

  const missingHeroShips = ships.filter((s) => !hasHeroUrl(s.hero_image_url)).length;

  const summary = {
    generated_mode: "read_only_local_ship_image_audit",
    brand_imaging_root: scan.root_dir,
    totals: {
      local_image_files_inspected: (scan.images || []).length,
      cruise_line_folders_found: (scan.line_folders || []).filter((l) => l.kind === "line")
        .length,
      non_catalogue_meta_folders: (scan.line_folders || []).filter((l) => l.kind === "non_line")
        .length,
      ship_folders_found: (scan.ship_folders || []).filter((s) => s.is_ship_folder).length,
      canonical_cruise_lines: lines.length,
      canonical_ships: ships.length,
      canonical_missing_hero_ships: missingHeroShips,
      aliases_loaded: aliases.length
    },
    matching: {
      exact_canonical_ship_matches: exactMatches,
      probable_matches: probableMatches,
      ambiguous_matches: ambiguousMatches,
      exact_local_ship_folder_matches: exactFolderMatches,
      probable_local_ship_folder_matches: probableFolderMatches,
      ambiguous_local_ship_folders: ambiguousFolders,
      unmatched_local_ship_folders: unmatchedShipFolders,
      ownership_conflicts: ownershipConflicts,
      canonical_missing_hero_with_no_local_folder: noLocalMatchMissingHero
    },
    hero_gap: {
      missing_hero_ships_with_suitable_local_hero: missingWithSuitable,
      clear_single_candidate: clearSingle,
      preferred_candidate_with_alternatives: preferredWithAlts,
      steve_selection_required: steveSelection,
      no_suitable_exterior_image: noSuitable,
      local_images_for_ships_already_with_canonical_hero: alreadyHasHeroWithLocal
    },
    quality: {
      duplicate_groups: duplicateGroups.length,
      cross_ship_folder_duplicate_groups: crossShipDuplicates.length,
      icloud_placeholders_not_downloaded: cloudPlaceholders.length,
      corrupt_or_unreadable_files: corruptFiles.length,
      low_resolution_files: lowRes.length,
      portrait_only_matched_ship_sets: portraitOnlySets,
      matched_ships_with_no_exterior_keyword_image: shipFoldersNoExterior,
      total_anomalies: anomalies.length
    },
    writes: {
      database_inserts: 0,
      database_updates: 0,
      database_deletes: 0,
      storage_writes: 0,
      storage_deletes: 0,
      dev_writes: 0,
      local_file_changes: 0
    }
  };

  return {
    summary,
    coverageRows,
    folderMatchRows,
    heroCandidateRows,
    anomalies,
    lineFolderMatches,
    shipFolderMatches,
    duplicateGroups,
    fleetReuseForReview,
    corruptFiles
  };
}

export function formatTerminalSummary(summary) {
  const t = summary.totals;
  const m = summary.matching;
  const h = summary.hero_gap;
  const q = summary.quality;
  const w = summary.writes;
  return [
    "=== Local Brand Imaging ship-image audit (READ-ONLY) ===",
    `Root: ${summary.brand_imaging_root}`,
    `Local image files inspected: ${t.local_image_files_inspected}`,
    `Cruise-line folders found: ${t.cruise_line_folders_found}`,
    `Ship folders found: ${t.ship_folders_found}`,
    `Exact canonical ship matches: ${m.exact_canonical_ship_matches}`,
    `Probable matches: ${m.probable_matches}`,
    `Ambiguous matches: ${m.ambiguous_matches}`,
    `Unmatched local ship folders: ${m.unmatched_local_ship_folders}`,
    `Canonical ships with ≥1 suitable local hero: ${h.missing_hero_ships_with_suitable_local_hero}`,
    `Clear single-candidate heroes: ${h.clear_single_candidate}`,
    `Preferred with alternatives: ${h.preferred_candidate_with_alternatives}`,
    `Ships requiring Steve’s selection: ${h.steve_selection_required}`,
    `Ships with no suitable exterior image: ${h.no_suitable_exterior_image}`,
    `Canonical missing-hero ships with no local folder: ${m.canonical_missing_hero_with_no_local_folder}`,
    `Local images for ships that already have a canonical hero: ${h.local_images_for_ships_already_with_canonical_hero}`,
    `Duplicate groups: ${q.duplicate_groups}`,
    `iCloud placeholders (not downloaded; content skipped): ${q.icloud_placeholders_not_downloaded}`,
    `Corrupt/unreadable files: ${q.corrupt_or_unreadable_files}`,
    `Ownership conflicts: ${m.ownership_conflicts}`,
    `Total anomalies: ${q.total_anomalies}`,
    `DB inserts/updates/deletes: ${w.database_inserts}/${w.database_updates}/${w.database_deletes}`,
    `Storage writes/deletes: ${w.storage_writes}/${w.storage_deletes}`,
    `DEV writes: ${w.dev_writes}`,
    `Local file changes: ${w.local_file_changes}`
  ].join("\n");
}
