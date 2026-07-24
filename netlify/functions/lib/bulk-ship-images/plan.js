/**
 * Build dry-run / import plans for bulk ship images.
 */

"use strict";

const {
  LIMITS,
  groupSingleLineEntries,
  groupFullLibraryEntries,
  matchShipFolder,
  matchLineFolder,
  sha256Hex,
  mimeFromExt,
  buildContentAddressedPath,
  safeFilename
} = require("./matching");

function emptyReport(base = {}) {
  return {
    mode: base.mode || "single_line",
    cruise_line: base.cruise_line || null,
    ship_folders: [],
    matched_ships: [],
    unmatched_ship_folders: [],
    unmatched_line_folders: [],
    images_found: 0,
    images_per_ship: {},
    unsupported_files: [],
    ignored_files: [],
    loose_files: [],
    duplicate_candidates: [],
    proposed_uploads: [],
    proposed_heroes: [],
    estimated_upload_bytes: 0,
    limits: LIMITS,
    ...base
  };
}

function buildSingleLinePlan({
  entryPaths,
  cruiseLine,
  ships,
  aliases,
  existingHashesByShip,
  entrySizes = {}
}) {
  const report = emptyReport({
    mode: "single_line",
    cruise_line: cruiseLine
      ? { id: cruiseLine.id, name: cruiseLine.name, slug: cruiseLine.slug }
      : null
  });

  const grouped = groupSingleLineEntries(entryPaths);
  report.ignored_files = grouped.ignored;
  report.unsupported_files = grouped.unsupported.map((u) => ({
    path: u.path,
    ext: u.ext,
    basename: u.basename
  }));
  report.loose_files = grouped.loose.map((f) => f.path);

  for (const [folder, images] of grouped.byShip.entries()) {
    report.ship_folders.push(folder);
    report.images_per_ship[folder] = images.length;
    report.images_found += images.length;

    const match = matchShipFolder(folder, ships, aliases);
    if (!match) {
      report.unmatched_ship_folders.push({
        folder,
        image_count: images.length
      });
      continue;
    }

    report.matched_ships.push({
      folder,
      ship_id: match.ship.id,
      ship_name: match.ship.name,
      via: match.via,
      image_count: images.length,
      has_hero: Boolean(match.ship.hero_image_url)
    });

    const hashSet = existingHashesByShip?.get(match.ship.id) || new Set();

    for (const image of images) {
      const size = Number(entrySizes[image.path] || entrySizes[image.relative_path] || 0);
      const item = {
        zip_path: image.path,
        relative_path: image.relative_path,
        filename: image.filename,
        ship_id: match.ship.id,
        ship_name: match.ship.name,
        cruise_line_id: cruiseLine?.id || match.ship.cruise_line_id,
        is_hero_candidate: image.isHeroCandidate,
        mime_type: mimeFromExt(image.ext),
        size_bytes: size || null
      };

      // Hash unknown until bytes read — placeholder for dry-run path listing.
      report.proposed_uploads.push(item);
      if (size) report.estimated_upload_bytes += size;

      if (image.isHeroCandidate) {
        report.proposed_heroes.push({
          ...item,
          existing_hero_url: match.ship.hero_image_url || null,
          will_auto_apply: false,
          suggest_only: !match.ship.hero_image_url
        });
      }
    }

    // Attach known-hash duplicates when hashes provided (import phase fills this).
    if (hashSet.size && report._hashProbe) {
      /* filled by enrichPlanWithBytes */
    }
  }

  return report;
}

function enrichPlanWithBytes(report, fileRecords, existingHashesByShip) {
  const proposed = [];
  const duplicates = [];
  let uploadBytes = 0;

  for (const rec of fileRecords) {
    const hash = rec.content_hash || sha256Hex(rec.buffer);
    const path = buildContentAddressedPath(rec.ship_id, hash, rec.filename);
    const existing = existingHashesByShip?.get(rec.ship_id);
    const isDup = existing?.has(hash);

    const row = {
      zip_path: rec.zip_path,
      filename: rec.filename,
      original_filename: rec.filename,
      ship_id: rec.ship_id,
      ship_name: rec.ship_name,
      cruise_line_id: rec.cruise_line_id,
      content_hash: hash,
      storage_path: path,
      mime_type: rec.mime_type,
      size_bytes: rec.buffer.length,
      width: rec.width || null,
      height: rec.height || null,
      is_hero_candidate: Boolean(rec.is_hero_candidate),
      file_name: safeFilename(rec.filename)
    };

    if (isDup) {
      duplicates.push({ ...row, reason: "same_content_hash_for_ship" });
    } else {
      proposed.push(row);
      uploadBytes += rec.buffer.length;
    }
  }

  report.proposed_uploads = proposed;
  report.duplicate_candidates = duplicates;
  report.estimated_upload_bytes = uploadBytes;
  report.proposed_heroes = proposed
    .filter((p) => p.is_hero_candidate)
    .map((p) => ({
      ...p,
      will_auto_apply: false,
      suggest_only: true
    }));
  return report;
}

function buildFullLibraryPlan({ entryPaths, lines, shipsByLineId, aliasesByLineId }) {
  const report = emptyReport({ mode: "full_library", cruise_line: null });
  const grouped = groupFullLibraryEntries(entryPaths);
  report.ignored_files = grouped.ignored;
  report.unsupported_files = grouped.unsupported.map((u) => ({
    path: u.path,
    ext: u.ext
  }));
  report.loose_files = grouped.loose.map((f) => f.path);

  for (const [lineFolder, shipsMap] of grouped.byLine.entries()) {
    const lineMatch = matchLineFolder(lineFolder, lines);
    if (!lineMatch) {
      report.unmatched_line_folders.push({
        folder: lineFolder,
        ship_folders: [...shipsMap.keys()]
      });
      continue;
    }
    const ships = shipsByLineId?.get(lineMatch.line.id) || [];
    const aliases = aliasesByLineId?.get(lineMatch.line.id) || [];
    for (const [shipFolder, images] of shipsMap.entries()) {
      report.ship_folders.push(`${lineFolder}/${shipFolder}`);
      report.images_found += images.length;
      report.images_per_ship[`${lineFolder}/${shipFolder}`] = images.length;
      const match = matchShipFolder(shipFolder, ships, aliases);
      if (!match) {
        report.unmatched_ship_folders.push({
          line_folder: lineFolder,
          folder: shipFolder,
          cruise_line_id: lineMatch.line.id,
          image_count: images.length
        });
        continue;
      }
      report.matched_ships.push({
        line_folder: lineFolder,
        folder: shipFolder,
        cruise_line_id: lineMatch.line.id,
        cruise_line_name: lineMatch.line.name,
        ship_id: match.ship.id,
        ship_name: match.ship.name,
        via: match.via,
        image_count: images.length
      });
      for (const image of images) {
        report.proposed_uploads.push({
          zip_path: image.path,
          filename: image.filename,
          ship_id: match.ship.id,
          ship_name: match.ship.name,
          cruise_line_id: lineMatch.line.id,
          is_hero_candidate: image.isHeroCandidate,
          mime_type: mimeFromExt(image.ext)
        });
      }
    }
  }
  return report;
}

module.exports = {
  emptyReport,
  buildSingleLinePlan,
  buildFullLibraryPlan,
  enrichPlanWithBytes
};
