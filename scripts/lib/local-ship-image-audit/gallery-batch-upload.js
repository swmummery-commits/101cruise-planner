/**
 * Strict secondary ship-gallery selection + upload helpers.
 * Never replaces heroes. Never uploads rooms or cruise-line loose heroes.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  MEDIA_BUCKET,
  buildShipStoragePath,
  publicMediaUrl,
  sha256Hex,
  sniffMime,
  assertAllowedMime
} from "../squarespace-ci-media/media-utils.js";
import { softShipKey, foldKey } from "./normalize.js";
import { classifyImageRole } from "./classify.js";
import { MAX_UPLOAD_BYTES } from "./hero-batch-upload.js";

const require = createRequire(import.meta.url);
const { readImageDimensions } = require("../../../netlify/functions/lib/bulk-ship-images/image-dims.js");

export const IMPORT_SOURCE_GALLERY_BATCH_1 = "external_brand_imaging_gallery_batch_1";
export const CONFIRM_TOKEN_GALLERY_BATCH_1 = "UPLOAD-EXTERNAL-SHIP-GALLERY-BATCH-1";
export const MAX_GALLERY_PER_SHIP = 3;
export const MAX_SAME_ROLE_PER_SHIP = 2;

const MATCH_OK = new Set(["exact_match", "safe_normalised_match"]);
const MEDIA_STATUS_OK = new Set([
  "new_candidate",
  "candidate_could_replace_existing_hero_requires_review"
]);

const IDENTITY_EXCLUDE_RULES = [
  {
    test: (i) => i.ship_name === "Scenic Eclipse II" || /Scenic-Eclipse-Heli/i.test(i.absolute_path || ""),
    reason: "scenic_eclipse_identity_risk"
  },
  {
    test: (i) => /Disney/i.test(i.cruise_line_name || "") || /\/Disney/i.test(i.absolute_path || ""),
    reason: "disney_short_name_ambiguity"
  },
  {
    test: (i) =>
      /Holland America/i.test(i.cruise_line_name || "") && /Rotterdam/i.test(i.ship_name || ""),
    reason: "holland_america_rotterdam_ambiguity"
  },
  {
    test: (i) => /Regent/i.test(i.cruise_line_name || "") && /Explorer/i.test(i.ship_name || ""),
    reason: "regent_explorer_ambiguity"
  },
  {
    test: (i) =>
      i.ship_name === "Brilliant Lady" && /valiant/i.test(path.basename(i.absolute_path || "")),
    reason: "filename_branded_as_different_ship_valiant_lady"
  },
  {
    test: (i) => /\bcgi\b/i.test(path.basename(i.absolute_path || "")),
    reason: "cgi_rendering_requires_review"
  },
  {
    test: (i) => {
      const f = path.basename(i.absolute_path || "").toLowerCase();
      return f.endsWith("_n.jpg") || f.endsWith("_n.jpeg");
    },
    reason: "instagram_dump_filename_low_confidence"
  }
];

function normFilename(name) {
  return foldKey(String(name || "").replace(/\.[^.]+$/, ""));
}

function blobFor(item) {
  const abs = String(item.absolute_path || item.source_pathname || "");
  const fname = path.basename(abs);
  const rel = abs.includes("BRAND IMAGING/")
    ? abs.split("BRAND IMAGING/")[1]
    : abs;
  return `${rel} ${fname}`.toLowerCase().replace(/[_-]+/g, " ");
}

/**
 * Underscore-aware room / cabin detection (classifyImageRole \b misses snake_case).
 */
export function isRoomTypeImage(item) {
  const blob = blobFor(item);
  if (/\/rooms\//i.test(String(item.absolute_path || ""))) return true;
  if (
    /\b(cabin|stateroom|state room|minisuite|mini suite|owners? suite|sky suite|penthouse|accommodations?|ocean ?view|inside stateroom|balcony room)\b/.test(
      blob
    )
  ) {
    return true;
  }
  const role = classifyImageRole({
    filename: path.basename(item.absolute_path || ""),
    relativePath: item.absolute_path || ""
  });
  return role === "cabin_image";
}

export function isCruiseLineLooseHeroPath(item) {
  const abs = String(item.absolute_path || "");
  // Loose "Hero Images" folders sit under the line, not a ship folder.
  return /\/Hero Images\//i.test(abs) || /\/HeroImages\//i.test(abs);
}

export function inferGalleryRole(item) {
  const blob = blobFor(item);
  if (isRoomTypeImage(item)) return "room";
  if (
    /\b(pool|lido|deck|cabana|sun ?deck|upper deck|poolside)\b/.test(blob)
  ) {
    return "deck_pool";
  }
  if (
    /\b(atrium|lounge|theatre|theater|restaurant|dining|pizzeria|buffet|spa|casino|piazza|bar|fitness|gym|interior)\b/.test(
      blob
    )
  ) {
    return "interior_public";
  }
  if (
    /\b(exterior|aerial|profile|at sea|underway|bow|aft|broadside|ship|vessel|rendering)\b/.test(
      blob
    )
  ) {
    return "exterior";
  }
  const role = classifyImageRole({
    filename: path.basename(item.absolute_path || ""),
    relativePath: item.absolute_path || ""
  });
  if (role === "interior_image") return "interior_public";
  if (role === "exterior_ship_hero") return "exterior";
  return "feature_or_unknown";
}

export function nearDupKey(img) {
  const w = Number(img.width) || 0;
  const h = Number(img.height) || 0;
  const sz = Number(img.file_size_bytes) || 0;
  if (!w || !h || !sz) return null;
  const sizeBucket = Math.round(sz / 4096);
  const fname = normFilename(img.filename || path.basename(img.absolute_path || ""));
  return `${w}x${h}:${sizeBucket}:${fname}`;
}

export function isNearDuplicatePair(a, b) {
  if (!a || !b) return false;
  if (a.content_hash && b.content_hash && a.content_hash === b.content_hash) {
    return true;
  }
  const ka = nearDupKey(a);
  const kb = nearDupKey(b);
  if (ka && kb && ka === kb) return true;

  const wa = Number(a.width) || 0;
  const ha = Number(a.height) || 0;
  const wb = Number(b.width) || 0;
  const hb = Number(b.height) || 0;
  const sa = Number(a.file_size_bytes) || 0;
  const sb = Number(b.file_size_bytes) || 0;
  if (wa && ha && wa === wb && ha === hb && sa && sb) {
    const sizeDelta = Math.abs(sa - sb) / Math.max(sa, sb);
    if (sizeDelta <= 0.05) {
      const fa = normFilename(a.filename || path.basename(a.absolute_path || ""));
      const fb = normFilename(b.filename || path.basename(b.absolute_path || ""));
      if (fa && fb && (fa === fb || fa.includes(fb) || fb.includes(fa))) {
        return true;
      }
    }
  }
  return false;
}

function identityExcludeReason(item) {
  for (const rule of IDENTITY_EXCLUDE_RULES) {
    if (rule.test(item)) return rule.reason;
  }
  return null;
}

/**
 * Load hero map from batch-1 + batch-2 success results.
 */
export function loadHeroShipsFromResults(batch1Results, batch2Results) {
  const map = new Map();
  for (const results of [batch1Results, batch2Results]) {
    for (const row of results?.results || []) {
      if (row?.status !== "success" || !row.ship_id) continue;
      map.set(row.ship_id, {
        ship_id: row.ship_id,
        ship_name: row.ship_name,
        cruise_line_id: row.cruise_line_id,
        cruise_line_name: row.cruise_line_name,
        hero_content_hash: row.content_hash || null,
        hero_source_pathname: row.source_pathname || null,
        hero_public_url: row.new_hero_value || row.public_url || null,
        hero_file_size_bytes: row.file_size_bytes || null,
        hero_dimensions: row.dimensions || null
      });
    }
  }
  return map;
}

function parseDimensions(dims) {
  if (!dims || typeof dims !== "string") return { width: 0, height: 0 };
  const m = /^(\d+)x(\d+)$/.exec(dims.trim());
  if (!m) return { width: 0, height: 0 };
  return { width: Number(m[1]), height: Number(m[2]) };
}

/**
 * Build strict gallery batch (max 3 / ship) with role variety.
 *
 * @param {{
 *   galleryCandidates: object[],
 *   heroCandidates?: object[],
 *   heroShips: Map<string, object>,
 *   maxPerShip?: number
 * }} opts
 */
export function buildStrictGalleryBatch({
  galleryCandidates = [],
  heroCandidates = [],
  heroShips,
  maxPerShip = MAX_GALLERY_PER_SHIP
} = {}) {
  const approved = [];
  const excluded = [];
  const heldForLater = [];

  if (!(heroShips instanceof Map)) {
    throw new Error("heroShips Map required");
  }

  const heroHashes = new Set(
    [...heroShips.values()].map((h) => h.hero_content_hash).filter(Boolean)
  );
  const heroPaths = new Set(
    [...heroShips.values()].map((h) => h.hero_source_pathname).filter(Boolean)
  );

  const poolByShip = new Map();

  const consider = (raw, sourceKind) => {
    const item = {
      ...raw,
      absolute_path: raw.absolute_path,
      filename: path.basename(raw.absolute_path || ""),
      source_kind: sourceKind
    };

    if (!item.ship_id) {
      excluded.push({ ...item, exclude_reason: "missing_ship_id" });
      return;
    }
    if (!heroShips.has(item.ship_id)) {
      heldForLater.push({
        ...item,
        hold_reason: "ship_not_in_hero_batches_1_2"
      });
      return;
    }
    if (!MATCH_OK.has(item.match_class)) {
      excluded.push({ ...item, exclude_reason: "match_class_not_exact_or_safe" });
      return;
    }
    if (!MEDIA_STATUS_OK.has(item.media_status)) {
      excluded.push({
        ...item,
        exclude_reason: `media_status_${item.media_status || "unknown"}`
      });
      return;
    }
    if (isCruiseLineLooseHeroPath(item)) {
      excluded.push({ ...item, exclude_reason: "cruise_line_loose_hero_image" });
      return;
    }
    if (isRoomTypeImage(item)) {
      excluded.push({ ...item, exclude_reason: "room_type_image" });
      return;
    }
    if (Number(item.file_size_bytes || 0) > MAX_UPLOAD_BYTES) {
      excluded.push({ ...item, exclude_reason: "exceeds_10mb_storage_limit" });
      return;
    }
    if (
      heroHashes.has(item.content_hash) ||
      heroPaths.has(item.absolute_path)
    ) {
      excluded.push({ ...item, exclude_reason: "duplicate_of_batch_hero" });
      return;
    }

    const idReason = identityExcludeReason(item);
    if (idReason) {
      excluded.push({ ...item, exclude_reason: idReason });
      return;
    }

    const hero = heroShips.get(item.ship_id);
    const heroDims = parseDimensions(hero.hero_dimensions);
    const heroProxy = {
      content_hash: hero.hero_content_hash,
      absolute_path: hero.hero_source_pathname,
      filename: path.basename(hero.hero_source_pathname || ""),
      width: heroDims.width,
      height: heroDims.height,
      file_size_bytes: hero.hero_file_size_bytes
    };
    if (isNearDuplicatePair(item, heroProxy)) {
      excluded.push({ ...item, exclude_reason: "near_duplicate_of_current_hero" });
      return;
    }

    // Reject filenames that name a different vessel than the matched ship.
    const softShip = softShipKey(item.ship_name || "");
    const softFile = softShipKey(item.filename || "");
    if (softShip && softFile) {
      const shipTokens = softShip.split(" ").filter((t) => t.length >= 5);
      const otherVesselHint =
        /\b(valiant|scarlet|resilient|utopia of the seas|icon of the seas|wonder of the seas)\b/i.test(
          item.filename || ""
        );
      if (otherVesselHint) {
        const mentionsOwn = shipTokens.some((t) => softFile.includes(t));
        if (!mentionsOwn) {
          excluded.push({
            ...item,
            exclude_reason: "filename_suggests_different_vessel"
          });
          return;
        }
      }
    }

    item.gallery_role = inferGalleryRole(item);
    if (item.gallery_role === "room") {
      excluded.push({ ...item, exclude_reason: "room_type_image" });
      return;
    }

    if (!poolByShip.has(item.ship_id)) poolByShip.set(item.ship_id, []);
    poolByShip.get(item.ship_id).push(item);
  };

  for (const g of galleryCandidates) consider(g, "gallery_candidate");
  for (const h of heroCandidates) {
    // Unused excellent exteriors may diversify galleries beyond the chosen hero.
    if (h.quality_class !== "excellent_hero_candidate") continue;
    consider(h, "unused_excellent_exterior");
  }

  for (const [shipId, pool] of poolByShip) {
    const hero = heroShips.get(shipId);
    // Dedupe pool by content_hash / path
    const seen = new Set();
    const unique = [];
    for (const item of pool) {
      const key = item.content_hash || item.absolute_path;
      if (seen.has(key)) {
        excluded.push({ ...item, exclude_reason: "duplicate_in_pool" });
        continue;
      }
      seen.add(key);
      unique.push(item);
    }
    unique.sort((a, b) => (b.score || 0) - (a.score || 0));

    const selected = [];
    const roleCounts = new Map();

    for (const item of unique) {
      if (selected.length >= maxPerShip) {
        heldForLater.push({
          ...item,
          hold_reason: "exceeds_max_three_per_ship"
        });
        continue;
      }
      if (selected.some((s) => isNearDuplicatePair(s, item))) {
        excluded.push({
          ...item,
          exclude_reason: "near_duplicate_of_selected_gallery"
        });
        continue;
      }
      const role = item.gallery_role || "feature_or_unknown";
      const count = roleCounts.get(role) || 0;
      if (count >= MAX_SAME_ROLE_PER_SHIP) {
        excluded.push({
          ...item,
          exclude_reason: `role_cap_${role}`
        });
        continue;
      }
      // Prefer variety: if we already have 2 items and this role is already used,
      // skip unless no unused-role alternatives remain later — simple greedy: skip
      // third same-role when another unselected role exists higher? Keep greedy
      // with role cap of 2 and max 3 total.
      roleCounts.set(role, count + 1);
      selected.push({
        ...item,
        cruise_line_id: item.cruise_line_id || hero.cruise_line_id,
        cruise_line_name: item.cruise_line_name || hero.cruise_line_name,
        ship_name: item.ship_name || hero.ship_name,
        intended_gallery_role: role,
        display_order: selected.length + 1,
        current_hero_url: hero.hero_public_url,
        hero_content_hash: hero.hero_content_hash
      });
    }

    // If we somehow selected 3 exteriors only, drop the lowest-scoring third.
    const exteriorOnly =
      selected.length === 3 && selected.every((s) => s.intended_gallery_role === "exterior");
    if (exteriorOnly) {
      const dropped = selected.pop();
      roleCounts.set("exterior", 2);
      excluded.push({
        ...dropped,
        exclude_reason: "avoid_three_near_identical_exteriors"
      });
      // renumber
      selected.forEach((s, i) => {
        s.display_order = i + 1;
      });
    }

    approved.push(...selected);
  }

  // Ships in hero batches with zero approved gallery images are fine (0).
  return {
    approved,
    excluded,
    held_for_later: heldForLater,
    ship_count: new Set(approved.map((a) => a.ship_id)).size,
    image_count: approved.length,
    per_ship: summarisePerShip(approved)
  };
}

function summarisePerShip(approved) {
  const map = new Map();
  for (const a of approved) {
    if (!map.has(a.ship_id)) {
      map.set(a.ship_id, {
        ship_id: a.ship_id,
        ship_name: a.ship_name,
        cruise_line_name: a.cruise_line_name,
        count: 0,
        roles: []
      });
    }
    const row = map.get(a.ship_id);
    row.count += 1;
    row.roles.push(a.intended_gallery_role);
  }
  return [...map.values()].sort((a, b) => a.ship_name.localeCompare(b.ship_name));
}

export function inspectLocalShipGallery(item, buffer, { supabaseUrl }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw Object.assign(new Error("empty_or_unreadable"), { code: "empty_file" });
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error("exceeds_10mb_storage_limit"), { code: "too_large" });
  }

  const mime = sniffMime(buffer);
  assertAllowedMime(mime);

  const dims = readImageDimensions(buffer);
  if (!dims.width || !dims.height) {
    throw Object.assign(new Error("dimensions_unreadable"), { code: "bad_dims" });
  }

  const contentHash = sha256Hex(buffer);
  const originalFilename = path.basename(item.absolute_path);
  const storagePath = buildShipStoragePath(item.ship_id, contentHash, originalFilename);
  const proposedPublicUrl = publicMediaUrl(supabaseUrl, storagePath);
  const order = Number(item.display_order) || 1;
  const orderLabel = String(order).padStart(2, "0");

  if (!storagePath.startsWith(`ships/${item.ship_id}/`)) {
    throw Object.assign(new Error("unsafe_storage_path"), { code: "bad_path" });
  }

  return {
    ship_id: item.ship_id,
    ship_name: item.ship_name,
    cruise_line_id: item.cruise_line_id,
    cruise_line_name: item.cruise_line_name,
    source_pathname: item.absolute_path,
    filename: originalFilename,
    bytes: buffer.length,
    width: dims.width,
    height: dims.height,
    mime_type: mime,
    content_hash: contentHash,
    storage_bucket: MEDIA_BUCKET,
    storage_path: storagePath,
    proposed_public_url: proposedPublicUrl,
    display_order: order,
    intended_gallery_role: item.intended_gallery_role || inferGalleryRole(item),
    media_library_values: {
      media_type: "ship",
      cruise_line_id: item.cruise_line_id,
      ship_id: item.ship_id,
      title: `${item.ship_name} gallery ${orderLabel}`,
      alt_text: `${item.ship_name} gallery photo`,
      public_url: proposedPublicUrl,
      storage_bucket: MEDIA_BUCKET,
      storage_path: storagePath,
      original_filename: originalFilename,
      file_name: originalFilename,
      mime_type: mime,
      width: dims.width,
      height: dims.height,
      file_size_bytes: buffer.length,
      import_source: IMPORT_SOURCE_GALLERY_BATCH_1,
      content_hash: contentHash,
      source_url: null,
      is_default: false,
      is_active: true,
      tags: [
        "ship_gallery",
        "external_brand_imaging",
        "gallery_batch_1",
        item.intended_gallery_role || "feature_or_unknown"
      ]
    }
  };
}

export function readLocalImageBuffer(absolutePath) {
  return fs.readFileSync(absolutePath);
}

export function toCsv(rows, columns) {
  const esc = (v) => {
    if (v == null) return "";
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const header = columns.join(",");
  const body = (rows || []).map((row) => columns.map((c) => esc(row[c])).join(",")).join("\n");
  return `${header}\n${body}${body ? "\n" : ""}`;
}

/**
 * Pure helper used by tests: simulate rollback of batch-created records only.
 */
export function planGalleryFailureRollback({
  storageCreated,
  mediaLibraryId,
  storagePath,
  preExistingMediaIds = [],
  preExistingStoragePaths = []
}) {
  const actions = [];
  if (mediaLibraryId && !preExistingMediaIds.includes(mediaLibraryId)) {
    actions.push({ type: "delete_media_library", id: mediaLibraryId });
  }
  if (storageCreated && storagePath && !preExistingStoragePaths.includes(storagePath)) {
    actions.push({ type: "delete_storage", path: storagePath });
  }
  return {
    actions,
    leaves_preexisting_untouched: true,
    would_touch_preexisting_media: actions.some(
      (a) => a.type === "delete_media_library" && preExistingMediaIds.includes(a.id)
    ),
    would_touch_preexisting_storage: actions.some(
      (a) => a.type === "delete_storage" && preExistingStoragePaths.includes(a.path)
    )
  };
}
