/**
 * Build Sprint-16 external-drive ship-image audit manifests.
 * Pure analysis — no I/O, no uploads.
 */

import { softShipKey, foldKey } from "./normalize.js";
import {
  buildCanonicalIndexes,
  matchCruiseLineFolder,
  matchShipFolder
} from "./match.js";
import {
  scoreHeroCandidate,
  classifyShipImageQuality,
  classifyLooseHeroImage,
  recommendFromCandidates
} from "./classify.js";

function hasHeroUrl(url) {
  return Boolean(url && String(url).trim());
}

function folderMatchLabel(status) {
  if (status === "exact_canonical_match") return "exact_match";
  if (
    status === "probable_canonical_match" ||
    status === "obsolete_former_ship_name"
  ) {
    return "safe_normalised_match";
  }
  if (status === "ambiguous" || status === "cruise_line_ownership_conflict") {
    return "ambiguous";
  }
  return "no_catalogue_match";
}

function normFilename(name) {
  return foldKey(String(name || "").replace(/\.[^.]+$/, ""));
}

function shipTokenInFilename(filename, shipName) {
  const soft = softShipKey(shipName);
  if (!soft || soft.length < 4) return false;
  const fname = softShipKey(filename);
  const tokens = soft.split(" ").filter((t) => t.length >= 4);
  if (!tokens.length) return fname.includes(soft) || soft.includes(fname);
  // Require primary distinctive token (first meaningful) present
  const primary = tokens[0];
  return fname.includes(primary) && tokens.filter((t) => fname.includes(t)).length >= 1;
}

function nearDupKey(img) {
  const w = img.width || 0;
  const h = img.height || 0;
  const sz = img.file_size_bytes || 0;
  if (!w || !h || !sz) return null;
  // Bucket size to catch re-exports with tiny size drift
  const sizeBucket = Math.round(sz / 4096);
  return `${w}x${h}:${sizeBucket}:${normFilename(img.filename)}`;
}

export function buildExternalShipImageAudit({
  scan,
  lines,
  ships,
  aliases = [],
  mediaLibrary = []
}) {
  const indexes = buildCanonicalIndexes(lines, ships, aliases);
  const linesById = indexes.linesById;
  const shipsById = indexes.shipsById;

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

  const shipFolderMatches = [];
  for (const sf of scan.ship_folders || []) {
    if (!sf.is_ship_folder) continue;
    const lineMatch = lineMatchByFolder.get(sf.parent_line_folder) || {
      status: "unmatched_local_folder",
      cruise_line_id: null
    };
    const matched = matchShipFolder(sf, lineMatch, indexes);
    shipFolderMatches.push({
      ...matched,
      match_class: folderMatchLabel(matched.status),
      absolute_path: sf.absolute_path
    });
  }

  // Local content-hash duplicates
  const byHash = new Map();
  for (const img of scan.images || []) {
    if (!img.content_hash) continue;
    if (!byHash.has(img.content_hash)) byHash.set(img.content_hash, []);
    byHash.get(img.content_hash).push(img);
  }
  const localDupHashes = new Set(
    [...byHash.entries()].filter(([, arr]) => arr.length > 1).map(([h]) => h)
  );

  // Near-dup within local set
  const byNear = new Map();
  for (const img of scan.images || []) {
    const k = nearDupKey(img);
    if (!k) continue;
    if (!byNear.has(k)) byNear.set(k, []);
    byNear.get(k).push(img);
  }
  const nearDupPaths = new Set();
  for (const [, arr] of byNear) {
    if (arr.length < 2) continue;
    // Keep first as primary; mark rest near-dup
    for (const img of arr.slice(1)) nearDupPaths.add(img.absolute_path);
  }

  // Media library indexes (no content_hash column — filename/dims/size/ship)
  const mediaByShip = new Map();
  const mediaByFilename = new Map();
  const mediaByDimSize = new Map();
  for (const m of mediaLibrary || []) {
    if (m.ship_id) {
      if (!mediaByShip.has(m.ship_id)) mediaByShip.set(m.ship_id, []);
      mediaByShip.get(m.ship_id).push(m);
    }
    const nf = normFilename(m.file_name || m.title || "");
    if (nf) {
      if (!mediaByFilename.has(nf)) mediaByFilename.set(nf, []);
      mediaByFilename.get(nf).push(m);
    }
    if (m.width && m.height && m.file_size_bytes != null) {
      const key = `${m.width}x${m.height}:${m.file_size_bytes}`;
      if (!mediaByDimSize.has(key)) mediaByDimSize.set(key, []);
      mediaByDimSize.get(key).push(m);
    }
  }

  function compareToMedia(img, shipId) {
    const nf = normFilename(img.filename);
    const dimKey =
      img.width && img.height && img.file_size_bytes != null
        ? `${img.width}x${img.height}:${img.file_size_bytes}`
        : null;
    const byName = mediaByFilename.get(nf) || [];
    const byDim = dimKey ? mediaByDimSize.get(dimKey) || [] : [];
    const shipMedia = shipId ? mediaByShip.get(shipId) || [] : [];

    const exactDimName = byName.find(
      (m) =>
        m.width === img.width &&
        m.height === img.height &&
        Number(m.file_size_bytes) === Number(img.file_size_bytes)
    );
    if (exactDimName) {
      return {
        media_status: "already_present_exact_duplicate",
        media_library_id: exactDimName.id,
        media_note: "filename+dimensions+size match"
      };
    }
    const dimHit = byDim[0];
    if (dimHit) {
      return {
        media_status: "likely_visual_duplicate",
        media_library_id: dimHit.id,
        media_note: "dimensions+size match"
      };
    }
    const nameHitSameShip = byName.find((m) => !shipId || m.ship_id === shipId);
    if (nameHitSameShip) {
      return {
        media_status: "likely_visual_duplicate",
        media_library_id: nameHitSameShip.id,
        media_note: "filename match"
      };
    }

    const existingDefault = shipMedia.find(
      (m) => m.is_default && m.media_type === "ship" && m.is_active !== false
    );
    if (existingDefault && hasHeroUrl(shipsById.get(shipId)?.hero_image_url)) {
      return {
        media_status: "existing_hero_already_better_or_present",
        media_library_id: existingDefault.id,
        media_note: "ship already has canonical hero / default media"
      };
    }
    if (hasHeroUrl(shipsById.get(shipId)?.hero_image_url)) {
      return {
        media_status: "candidate_could_replace_existing_hero_requires_review",
        media_library_id: null,
        media_note: "canonical hero_image_url present; do not overwrite automatically"
      };
    }
    return {
      media_status: "new_candidate",
      media_library_id: null,
      media_note: null
    };
  }

  const matchesByShipId = new Map();
  for (const m of shipFolderMatches) {
    if (!m.ship_id) continue;
    if (!matchesByShipId.has(m.ship_id)) matchesByShipId.set(m.ship_id, []);
    matchesByShipId.get(m.ship_id).push(m);
  }

  const imagesByShipFolder = new Map();
  for (const img of scan.images || []) {
    if (img.asset_bucket !== "ship_folder" || !img.parent_ship_folder) continue;
    const key = `${img.parent_cruise_line_folder}::${img.parent_ship_folder}`;
    if (!imagesByShipFolder.has(key)) imagesByShipFolder.set(key, []);
    imagesByShipFolder.get(key).push(img);
  }

  const auditRows = [];
  const heroCandidates = [];
  const galleryCandidates = [];
  const shipsNoSuitableHero = [];
  const exactMediaDupes = [];

  for (const m of shipFolderMatches) {
    const key = `${m.parent_line_folder}::${m.folder_name}`;
    const folderImages = imagesByShipFolder.get(key) || [];
    const ship = m.ship_id ? shipsById.get(m.ship_id) : null;
    const hasHero = ship ? hasHeroUrl(ship.hero_image_url) : false;

    const classified = folderImages.map((img) => {
      const isExactDup = localDupHashes.has(img.content_hash);
      const isNear = nearDupPaths.has(img.absolute_path);
      const q = classifyShipImageQuality(img, {
        isExactDuplicate: isExactDup && byHash.get(img.content_hash)?.[0]?.absolute_path !== img.absolute_path,
        isNearDuplicate: isNear
      });
      const scored = scoreHeroCandidate(img);
      const mediaCmp = m.ship_id
        ? compareToMedia(img, m.ship_id)
        : { media_status: "skipped_unmatched_ship", media_library_id: null, media_note: null };
      return {
        ...img,
        quality_class: q.quality_class,
        quality_reasons: q.reasons,
        score: scored.score,
        suitable: scored.suitable,
        ...mediaCmp
      };
    });

    const excellent = classified.filter(
      (c) => c.quality_class === "excellent_hero_candidate"
    );
    const secondary = classified.filter(
      (c) => c.quality_class === "suitable_secondary_gallery"
    );
    const rec = recommendFromCandidates(
      excellent.length
        ? excellent.map((c) => ({ ...c, suitable: true }))
        : classified.map((c) => ({
            ...c,
            suitable: c.quality_class === "suitable_secondary_gallery"
          }))
    );

    if (
      m.match_class === "exact_match" ||
      m.match_class === "safe_normalised_match"
    ) {
      if (excellent.length === 0 && secondary.length === 0) {
        shipsNoSuitableHero.push({
          ship_id: m.ship_id,
          ship_name: m.ship_name,
          cruise_line_name: m.cruise_line_name,
          local_folder: `${m.parent_line_folder}/${m.folder_name}`,
          image_count: folderImages.length,
          has_canonical_hero: hasHero
        });
      }
    }

    for (const c of excellent) {
      if (c.media_status === "already_present_exact_duplicate") {
        exactMediaDupes.push({
          ship_id: m.ship_id,
          ship_name: m.ship_name,
          absolute_path: c.absolute_path,
          media_library_id: c.media_library_id
        });
      }
      heroCandidates.push({
        ship_id: m.ship_id,
        ship_name: m.ship_name,
        cruise_line_id: m.cruise_line_id,
        cruise_line_name: m.cruise_line_name,
        match_class: m.match_class,
        has_canonical_hero: hasHero,
        recommendation: hasHero
          ? "review_only_existing_hero"
          : rec.recommendation,
        quality_class: c.quality_class,
        score: c.score,
        width: c.width,
        height: c.height,
        file_size_bytes: c.file_size_bytes,
        absolute_path: c.absolute_path,
        content_hash: c.content_hash,
        media_status: c.media_status,
        media_library_id: c.media_library_id,
        quality_reasons: (c.quality_reasons || []).join("|")
      });
    }

    for (const c of secondary) {
      galleryCandidates.push({
        ship_id: m.ship_id,
        ship_name: m.ship_name,
        cruise_line_name: m.cruise_line_name,
        match_class: m.match_class,
        quality_class: c.quality_class,
        score: c.score,
        width: c.width,
        height: c.height,
        file_size_bytes: c.file_size_bytes,
        absolute_path: c.absolute_path,
        content_hash: c.content_hash,
        media_status: c.media_status,
        media_library_id: c.media_library_id
      });
    }

    auditRows.push({
      local_line_folder: m.parent_line_folder,
      local_ship_folder: m.folder_name,
      absolute_path: m.absolute_path,
      match_class: m.match_class,
      match_status: m.status,
      match_method: m.match_method || "",
      ship_id: m.ship_id || "",
      ship_name: m.ship_name || "",
      cruise_line_id: m.cruise_line_id || "",
      cruise_line_name: m.cruise_line_name || "",
      has_canonical_hero: hasHero,
      image_count: folderImages.length,
      excellent_hero_count: excellent.length,
      secondary_gallery_count: secondary.length,
      usable_not_preferred_count: classified.filter(
        (c) => c.quality_class === "usable_but_not_preferred"
      ).length,
      unsuitable_count: classified.filter((c) => c.quality_class === "unsuitable")
        .length,
      corrupt_count: classified.filter(
        (c) => c.quality_class === "corrupt_or_unreadable"
      ).length,
      duplicate_count: classified.filter(
        (c) => c.quality_class === "duplicate_or_near_duplicate"
      ).length,
      top_hero_path: excellent[0]?.absolute_path || secondary[0]?.absolute_path || "",
      top_hero_score: excellent[0]?.score ?? secondary[0]?.score ?? "",
      recommendation: hasHero
        ? "existing_hero_review_only"
        : rec.recommendation,
      images: classified.map((c) => ({
        filename: c.filename,
        absolute_path: c.absolute_path,
        width: c.width,
        height: c.height,
        file_size_bytes: c.file_size_bytes,
        content_hash: c.content_hash,
        apparent_role: c.apparent_role,
        quality_class: c.quality_class,
        score: c.score,
        media_status: c.media_status,
        opens_successfully: c.opens_successfully,
        inspect_error: c.inspect_error
      }))
    });
  }

  // Loose Hero Images
  const looseHeroes = [];
  for (const img of scan.images || []) {
    if (img.asset_bucket !== "hero_loose") continue;
    const kind = classifyLooseHeroImage(img);
    const lineMatch = lineMatchByFolder.get(img.parent_cruise_line_folder);
    let attributableShip = null;
    let confidence = "none";
    if (lineMatch?.cruise_line_id) {
      const lineShips = ships.filter((s) => s.cruise_line_id === lineMatch.cruise_line_id);
      const hits = lineShips.filter((s) => shipTokenInFilename(img.filename, s.name));
      if (hits.length === 1) {
        attributableShip = {
          ship_id: hits[0].id,
          ship_name: hits[0].name
        };
        confidence = "high_filename";
        kind.kind = "clearly_attributable_to_specific_ship";
      } else if (hits.length > 1) {
        confidence = "ambiguous_filename";
        kind.kind = "unsuitable_or_ambiguous";
      }
    }
    looseHeroes.push({
      cruise_line_folder: img.parent_cruise_line_folder,
      cruise_line_id: lineMatch?.cruise_line_id || null,
      cruise_line_name: lineMatch?.cruise_line_name || null,
      filename: img.filename,
      absolute_path: img.absolute_path,
      width: img.width,
      height: img.height,
      file_size_bytes: img.file_size_bytes,
      content_hash: img.content_hash,
      classification: kind.kind,
      reasons: kind.reasons,
      attributable_ship: attributableShip,
      association_confidence: confidence
    });
  }

  // Room images
  const roomImages = [];
  for (const img of scan.images || []) {
    if (img.asset_bucket !== "room_type") continue;
    const lineMatch = lineMatchByFolder.get(img.parent_cruise_line_folder);
    let possibleShip = null;
    let possibleClass = null;
    let confidence = "uncertain";
    let recommendedUse = "hold_association_uncertain";

    if (lineMatch?.cruise_line_id) {
      const lineShips = ships.filter((s) => s.cruise_line_id === lineMatch.cruise_line_id);
      const hits = lineShips.filter((s) => shipTokenInFilename(img.filename, s.name));
      if (hits.length === 1) {
        possibleShip = { ship_id: hits[0].id, ship_name: hits[0].name };
        confidence = "high_filename_ship";
        recommendedUse = "future_ship_cabin_gallery";
      } else if (hits.length > 1) {
        confidence = "ambiguous_filename";
        recommendedUse = "hold_association_uncertain";
      } else {
        // Class token in path/filename only when explicit
        const blob = `${img.relative_path} ${img.filename}`.toLowerCase();
        if (/\b(edge class|solstice class|oasis class|quantum class|icon class)\b/.test(blob)) {
          const m = blob.match(/\b((?:edge|solstice|oasis|quantum|icon) class)\b/);
          possibleClass = m ? m[1] : null;
          confidence = "medium_class_keyword";
          recommendedUse = "future_ship_class_cabin_reference";
        } else {
          confidence = "cruise_line_generic";
          recommendedUse = "hold_or_line_generic_cabin_library";
          possibleClass = null;
        }
      }
    }

    roomImages.push({
      cruise_line: img.parent_cruise_line_folder,
      cruise_line_id: lineMatch?.cruise_line_id || null,
      cruise_line_name: lineMatch?.cruise_line_name || null,
      room_category: img.room_category,
      filename: img.filename,
      absolute_path: img.absolute_path,
      dimensions:
        img.width && img.height ? `${img.width}x${img.height}` : null,
      width: img.width,
      height: img.height,
      file_size_bytes: img.file_size_bytes,
      content_hash: img.content_hash,
      possible_ship: possibleShip?.ship_name || null,
      possible_ship_id: possibleShip?.ship_id || null,
      possible_ship_class: possibleClass,
      confidence,
      recommended_future_use: recommendedUse,
      association:
        confidence === "high_filename_ship"
          ? "clearly_linked_to_one_named_ship"
          : confidence === "medium_class_keyword"
            ? "linked_to_known_ship_class"
            : confidence === "cruise_line_generic"
              ? "cruise_line_generic"
              : "association_unknown"
    });
  }

  const roomByCategory = {};
  for (const r of roomImages) {
    const cat = r.room_category || "(unknown)";
    roomByCategory[cat] = (roomByCategory[cat] || 0) + 1;
  }

  const unmatchedFolders = {
    ambiguous_ship_folders: shipFolderMatches
      .filter((m) => m.match_class === "ambiguous")
      .map((m) => ({
        line: m.parent_line_folder,
        folder: m.folder_name,
        status: m.status,
        candidates: (m.candidates || []).map((c) => c.name || c.ship_name)
      })),
    unmatched_ship_folders: shipFolderMatches
      .filter((m) => m.match_class === "no_catalogue_match")
      .map((m) => ({
        line: m.parent_line_folder,
        folder: m.folder_name,
        status: m.status
      })),
    unmatched_line_folders: lineFolderMatches
      .filter(
        (m) =>
          m.status === "unmatched_local_folder" || m.status === "ambiguous"
      )
      .map((m) => ({
        folder: m.folder_name,
        status: m.status,
        candidates: (m.candidates || []).map((c) => c.name)
      })),
    non_ship_subfolders: (scan.ship_folders || [])
      .filter((s) => !s.is_ship_folder)
      .map((s) => ({
        line: s.parent_line_folder,
        folder: s.folder_name,
        folder_kind: s.folder_kind || null
      }))
  };

  const corrupt = (scan.images || [])
    .filter((i) => i.opens_successfully === false)
    .map((i) => ({
      absolute_path: i.absolute_path,
      filename: i.filename,
      file_size_bytes: i.file_size_bytes,
      inspect_error: i.inspect_error,
      asset_bucket: i.asset_bucket
    }));

  // One preferred new hero per ship (highest score among excellent new candidates)
  const newHeroByShip = new Map();
  for (const h of heroCandidates) {
    if (h.has_canonical_hero) continue;
    if (h.media_status !== "new_candidate") continue;
    if (h.match_class !== "exact_match" && h.match_class !== "safe_normalised_match") {
      continue;
    }
    if (!h.ship_id) continue;
    const prev = newHeroByShip.get(h.ship_id);
    if (!prev || (h.score || 0) > (prev.score || 0)) newHeroByShip.set(h.ship_id, h);
  }
  const newHeroUploads = [...newHeroByShip.values()];

  // Cap secondary gallery plan to top 3 new images per matched ship
  const galleryByShip = new Map();
  for (const g of galleryCandidates) {
    if (g.media_status !== "new_candidate") continue;
    if (g.match_class !== "exact_match" && g.match_class !== "safe_normalised_match") {
      continue;
    }
    if (!g.ship_id) continue;
    if (!galleryByShip.has(g.ship_id)) galleryByShip.set(g.ship_id, []);
    galleryByShip.get(g.ship_id).push(g);
  }
  const chosenHeroPaths = new Set(newHeroUploads.map((h) => h.absolute_path));
  const galleryUploads = [];
  for (const [shipId, arr] of galleryByShip) {
    arr.sort((a, b) => (b.score || 0) - (a.score || 0));
    const heroPath = newHeroByShip.get(shipId)?.absolute_path;
    const filtered = arr.filter(
      (g) => g.absolute_path !== heroPath && !chosenHeroPaths.has(g.absolute_path)
    );
    galleryUploads.push(...filtered.slice(0, 3));
  }
  const lineLevel = looseHeroes.filter(
    (l) => l.classification === "cruise_line_branding_general_hero"
  );
  const roomHold = roomImages.filter(
    (r) =>
      r.association === "association_unknown" ||
      r.association === "cruise_line_generic"
  );
  const roomMapped = roomImages.filter(
    (r) =>
      r.association === "clearly_linked_to_one_named_ship" ||
      r.association === "linked_to_known_ship_class"
  );
  const dupesSkipped = [
    ...heroCandidates.filter((h) =>
      String(h.media_status).includes("duplicate")
    ),
    ...galleryCandidates.filter((g) =>
      String(g.media_status).includes("duplicate")
    )
  ];
  const ambiguousSkipped = shipFolderMatches.filter(
    (m) => m.match_class === "ambiguous" || m.match_class === "no_catalogue_match"
  );

  const bytesOf = (rows, pathKey = "absolute_path") => {
    const paths = new Set(rows.map((r) => r[pathKey] || r.absolute_path));
    let n = 0;
    for (const img of scan.images || []) {
      if (paths.has(img.absolute_path)) n += img.file_size_bytes || 0;
    }
    return n;
  };

  const proposedUploadPlan = {
    note: "READ-ONLY plan. Do not upload until Steve approves controlled batches.",
    new_ship_heroes: {
      count: newHeroUploads.length,
      estimated_bytes: bytesOf(newHeroUploads),
      items: newHeroUploads
    },
    secondary_ship_gallery_images: {
      count: galleryUploads.length,
      estimated_bytes: bytesOf(galleryUploads),
      items: galleryUploads
    },
    cruise_line_level_images: {
      count: lineLevel.length,
      estimated_bytes: bytesOf(lineLevel),
      items: lineLevel
    },
    room_type_images_held_for_later_review: {
      count: roomImages.length,
      mapped_reliable: roomMapped.length,
      held_uncertain: roomHold.length,
      estimated_bytes: bytesOf(roomImages),
      items: roomImages
    },
    duplicates_skipped: {
      count: dupesSkipped.length,
      items: dupesSkipped
    },
    ambiguous_items_skipped: {
      count: ambiguousSkipped.length,
      items: ambiguousSkipped.map((m) => ({
        line: m.parent_line_folder,
        folder: m.folder_name,
        match_class: m.match_class,
        status: m.status
      }))
    },
    recommended_batches: [
      {
        batch: 1,
        name: "Priority ocean heroes — clear single excellent candidates, no existing hero",
        filter:
          "new_ship_heroes where recommendation=clear_single_candidate OR preferred_candidate_with_alternatives; one image per ship"
      },
      {
        batch: 2,
        name: "Steve selection required — multiple excellent candidates",
        filter: "new_ship_heroes where recommendation=Steve_selection_required"
      },
      {
        batch: 3,
        name: "Secondary gallery for ships that already received a hero in batch 1–2",
        filter: "secondary_ship_gallery_images for ships with approved heroes"
      },
      {
        batch: 4,
        name: "Cruise-line branding loose heroes (no ship assignment)",
        filter: "cruise_line_level_images"
      },
      {
        batch: 5,
        name: "Room-type library — only high_filename_ship / class-mapped rows",
        filter: "room_type_images where association is reliable; remainder stay on hold"
      }
    ]
  };

  const exactShipMatches = shipFolderMatches.filter(
    (m) => m.match_class === "exact_match"
  ).length;
  const safeNormMatches = shipFolderMatches.filter(
    (m) => m.match_class === "safe_normalised_match"
  ).length;

  const summary = {
    external_root: scan.root_dir,
    accessible: true,
    cruise_line_folders: (scan.line_folders || []).length,
    ship_folders: (scan.ship_folders || []).filter((s) => s.is_ship_folder).length,
    hero_image_folders: (scan.hero_image_folders || []).length,
    room_type_folders: (scan.room_type_folders || []).length,
    images_inspected: (scan.images || []).length,
    total_bytes: (scan.images || []).reduce(
      (a, i) => a + (i.file_size_bytes || 0),
      0
    ),
    exact_ship_matches: exactShipMatches,
    safe_normalised_ship_matches: safeNormMatches,
    ambiguous_ship_folders: unmatchedFolders.ambiguous_ship_folders.length,
    unmatched_ship_folders: unmatchedFolders.unmatched_ship_folders.length,
    excellent_hero_candidates: heroCandidates.length,
    secondary_gallery_candidates: galleryCandidates.length,
    ships_with_no_suitable_hero: shipsNoSuitableHero.length,
    exact_media_library_duplicates: exactMediaDupes.length,
    room_images_total: roomImages.length,
    room_images_by_category: roomByCategory,
    room_images_reliable_mapping: roomMapped.length,
    room_images_held_uncertain: roomHold.length,
    corrupt_or_unreadable: corrupt.length,
    loose_hero_images: looseHeroes.length,
    estimated_new_hero_upload_bytes: proposedUploadPlan.new_ship_heroes.estimated_bytes,
    estimated_gallery_upload_bytes:
      proposedUploadPlan.secondary_ship_gallery_images.estimated_bytes,
    estimated_total_proposed_upload_bytes:
      proposedUploadPlan.new_ship_heroes.estimated_bytes +
      proposedUploadPlan.secondary_ship_gallery_images.estimated_bytes +
      proposedUploadPlan.cruise_line_level_images.estimated_bytes
  };

  return {
    summary,
    auditRows,
    heroCandidates,
    galleryCandidates,
    roomImages,
    looseHeroes,
    unmatchedFolders,
    corrupt,
    proposedUploadPlan,
    shipsNoSuitableHero,
    exactMediaDupes,
    shipFolderMatches,
    lineFolderMatches
  };
}

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

export const AUDIT_CSV_COLUMNS = [
  "local_line_folder",
  "local_ship_folder",
  "match_class",
  "match_status",
  "ship_id",
  "ship_name",
  "cruise_line_name",
  "has_canonical_hero",
  "image_count",
  "excellent_hero_count",
  "secondary_gallery_count",
  "usable_not_preferred_count",
  "unsuitable_count",
  "corrupt_count",
  "duplicate_count",
  "top_hero_path",
  "top_hero_score",
  "recommendation"
];

export const ROOM_CSV_COLUMNS = [
  "cruise_line",
  "cruise_line_name",
  "room_category",
  "filename",
  "dimensions",
  "file_size_bytes",
  "possible_ship",
  "possible_ship_class",
  "confidence",
  "association",
  "recommended_future_use",
  "absolute_path"
];
