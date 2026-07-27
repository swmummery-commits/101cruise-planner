/**
 * Strict batch-1 external ship-hero selection + upload helpers.
 * Gallery / line / room images are never included.
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

const require = createRequire(import.meta.url);
const { readImageDimensions } = require("../../../netlify/functions/lib/bulk-ship-images/image-dims.js");

export const IMPORT_SOURCE = "external_brand_imaging_hero_batch_1";
export const IMPORT_SOURCE_BATCH_2 = "external_brand_imaging_hero_batch_2";
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const CONFIRM_TOKEN = "UPLOAD-EXTERNAL-SHIP-HEROES-BATCH-1";
export const CONFIRM_TOKEN_BATCH_2 = "UPLOAD-EXTERNAL-SHIP-HEROES-BATCH-2";

const IDENTITY_EXCLUDE_RULES = [
  {
    test: (i) => i.ship_name === "Scenic Eclipse II" || /Scenic-Eclipse-Heli/i.test(i.absolute_path),
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
    test: (i) =>
      i.ship_name === "Silver Dawn" &&
      /world cruise/i.test(path.basename(i.absolute_path || "")) &&
      !/dawn/i.test(path.basename(i.absolute_path || "")),
    reason: "generic_filename_identity_not_proven"
  },
  {
    test: (i) => /lido-deck/i.test(path.basename(i.absolute_path || "")),
    reason: "filename_suggests_deck_scene_not_ship_exterior_hero"
  },
  {
    test: (i) => /\bcgi\b/i.test(path.basename(i.absolute_path || "")),
    reason: "cgi_rendering_requires_steve_review"
  },
  {
    test: (i) => {
      const f = path.basename(i.absolute_path || "").toLowerCase();
      return f.endsWith("_n.jpg") || f.endsWith("_n.jpeg");
    },
    reason: "instagram_dump_filename_low_confidence"
  }
];

/**
 * Build strict approved batch from proposed-upload-plan new_ship_heroes items.
 */
export function buildStrictHeroBatch(planItems = []) {
  const approved = [];
  const excluded = [];

  for (const item of planItems) {
    const base = { ...item };
    if (!item?.ship_id) {
      excluded.push({ ...base, exclude_reason: "missing_ship_id" });
      continue;
    }
    if (!["exact_match", "safe_normalised_match"].includes(item.match_class)) {
      excluded.push({ ...base, exclude_reason: "match_class_not_exact_or_safe" });
      continue;
    }
    if (item.has_canonical_hero) {
      excluded.push({ ...base, exclude_reason: "has_canonical_hero" });
      continue;
    }
    if (item.recommendation === "Steve_selection_required") {
      excluded.push({ ...base, exclude_reason: "steve_selection_required" });
      continue;
    }
    if (
      !["clear_single_candidate", "preferred_candidate_with_alternatives"].includes(
        item.recommendation
      )
    ) {
      excluded.push({ ...base, exclude_reason: `recommendation_${item.recommendation}` });
      continue;
    }
    if (Number(item.file_size_bytes || 0) > MAX_UPLOAD_BYTES) {
      excluded.push({ ...base, exclude_reason: "exceeds_10mb_storage_limit" });
      continue;
    }

    let hit = null;
    for (const rule of IDENTITY_EXCLUDE_RULES) {
      if (rule.test(item)) {
        hit = rule.reason;
        break;
      }
    }
    if (hit) {
      excluded.push({ ...base, exclude_reason: hit });
      continue;
    }

    approved.push(base);
  }

  return { approved, excluded, count: approved.length };
}

export function inspectLocalShipHero(item, buffer, { supabaseUrl }) {
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
    media_library_values: {
      media_type: "ship",
      cruise_line_id: item.cruise_line_id,
      ship_id: item.ship_id,
      title: `${item.ship_name} hero`,
      alt_text: `${item.ship_name} exterior`,
      public_url: proposedPublicUrl,
      storage_bucket: MEDIA_BUCKET,
      storage_path: storagePath,
      original_filename: originalFilename,
      file_name: originalFilename,
      mime_type: mime,
      width: dims.width,
      height: dims.height,
      file_size_bytes: buffer.length,
      import_source: IMPORT_SOURCE,
      content_hash: contentHash,
      source_url: null,
      is_default: true,
      is_active: true,
      tags: ["ship_hero", "external_brand_imaging", "batch_1"]
    }
  };
}

export function readLocalImageBuffer(absolutePath) {
  return fs.readFileSync(absolutePath);
}

export function sha256FromPath(absolutePath) {
  const buffer = fs.readFileSync(absolutePath);
  return sha256Hex(buffer);
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
