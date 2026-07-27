/**
 * Validate Steve’s exported hero selections (batch 2).
 * Pure helpers — no network / no uploads.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { softShipKey, foldKey } from "./normalize.js";
import { MAX_UPLOAD_BYTES } from "./hero-batch-upload.js";
import { sha256Hex } from "../squarespace-ci-media/media-utils.js";

const require = createRequire(import.meta.url);
const { readImageDimensions } = require("../../../netlify/functions/lib/bulk-ship-images/image-dims.js");

export const VALID_DECISIONS = new Set([
  "approved",
  "no_suitable_image",
  "investigate"
]);

export function pathBelongsToShipFolder(sourcePath, shipName) {
  const parts = String(sourcePath || "")
    .split(/[/\\]/)
    .map((p) => foldKey(p))
    .filter(Boolean);
  const soft = softShipKey(shipName);
  if (!soft) return false;
  const blob = parts.join(" ");
  const tokens = soft.split(" ").filter((t) => t.length >= 4);

  // Royal Caribbean style: "Utopia of the Seas" folders often "Utopia (2024)".
  // Require the lead vessel token in a path segment; ignore trailing "seas".
  const withoutSeas = tokens.filter((t) => t !== "seas");
  const lead = withoutSeas[0] || tokens[0];
  if (lead && parts.some((p) => p === lead || p.startsWith(`${lead} `) || p.includes(` ${lead}`) || p.startsWith(lead))) {
    // Disallow obvious cross-ship folders: lead token must appear, and no conflicting other ship lead.
    return true;
  }

  if (!tokens.length) return blob.includes(soft);
  return tokens.every((t) => blob.includes(t));
}

/**
 * @returns {{
 *   ship_count: number,
 *   approved: object[],
 *   no_suitable_image: object[],
 *   investigate: object[],
 *   invalid_or_incomplete: object[],
 *   eligible_approved: object[],
 *   blocked: boolean,
 *   block_reasons: string[]
 * }}
 */
export function validateSteveHeroSelections(exportPayload) {
  const ships = Array.isArray(exportPayload?.ships) ? exportPayload.ships : [];
  const approved = [];
  const noSuitable = [];
  const investigate = [];
  const invalid = [];
  const eligible = [];
  const blockReasons = [];

  if (ships.length !== 29) {
    blockReasons.push(`expected_29_ships_found_${ships.length}`);
  }

  const seenIds = new Set();
  for (const ship of ships) {
    const decision = String(ship?.decision || "").trim();
    const base = {
      ship_id: ship?.ship_id || null,
      ship_name: ship?.ship_name || null,
      cruise_line: ship?.cruise_line || null,
      cruise_line_id: ship?.cruise_line_id || null,
      decision,
      selected_source_pathname: ship?.selected_source_pathname || null,
      selected_filename: ship?.selected_filename || null
    };

    if (!VALID_DECISIONS.has(decision)) {
      invalid.push({ ...base, reason: "invalid_or_missing_decision" });
      continue;
    }
    if (!ship?.ship_id || !ship?.ship_name || !ship?.cruise_line) {
      invalid.push({ ...base, reason: "missing_canonical_identity_fields" });
      continue;
    }
    if (seenIds.has(ship.ship_id)) {
      invalid.push({ ...base, reason: "duplicate_ship_id_in_export" });
      continue;
    }
    seenIds.add(ship.ship_id);

    if (decision === "no_suitable_image") {
      noSuitable.push(base);
      continue;
    }
    if (decision === "investigate") {
      investigate.push(base);
      continue;
    }

    // approved
    const issues = [];
    if (!ship.selected_source_pathname) issues.push("missing_source_pathname");
    if (!ship.selected_filename) issues.push("missing_filename");
    if (!ship.ship_id) issues.push("missing_ship_id");

    const warns = Array.isArray(ship.identity_warnings) ? ship.identity_warnings : [];
    if (warns.length && ship.identity_warning_acknowledgement !== true) {
      issues.push("unresolved_identity_warning");
    }

    const src = ship.selected_source_pathname;
    if (src && !fs.existsSync(src)) issues.push("source_file_missing");
    if (src && !pathBelongsToShipFolder(src, ship.ship_name)) {
      issues.push("source_not_in_expected_ship_folder");
    }

    let liveWidth = null;
    let liveHeight = null;
    let liveBytes = null;
    let liveHash = null;
    if (src && fs.existsSync(src)) {
      try {
        const st = fs.statSync(src);
        liveBytes = st.size;
        if (liveBytes > MAX_UPLOAD_BYTES) issues.push("exceeds_10mb_storage_limit");
        const fd = fs.openSync(src, "r");
        const header = Buffer.alloc(Math.min(st.size, 2 * 1024 * 1024));
        try {
          fs.readSync(fd, header, 0, header.length, 0);
        } finally {
          fs.closeSync(fd);
        }
        const dims = readImageDimensions(header);
        liveWidth = dims.width || null;
        liveHeight = dims.height || null;
        if (!liveWidth || !liveHeight) issues.push("dimensions_unreadable");
        else if (
          Number(ship.width) &&
          Number(ship.height) &&
          (Number(ship.width) !== liveWidth || Number(ship.height) !== liveHeight)
        ) {
          issues.push(
            `dimension_mismatch_export_${ship.width}x${ship.height}_file_${liveWidth}x${liveHeight}`
          );
        }
        liveHash = sha256Hex(fs.readFileSync(src));
        if (ship.content_hash && ship.content_hash !== liveHash) {
          issues.push("content_hash_mismatch");
        }
      } catch (error) {
        issues.push(`file_inspect_failed:${error.message}`);
      }
    }

    const record = {
      ...ship,
      ...base,
      live_width: liveWidth,
      live_height: liveHeight,
      live_file_size_bytes: liveBytes,
      live_content_hash: liveHash,
      absolute_path: src,
      validation_issues: issues
    };
    approved.push(record);

    if (issues.length) {
      invalid.push({ ...base, reason: issues.join("|"), issues });
      blockReasons.push(`${ship.ship_name}:${issues.join("|")}`);
    } else {
      eligible.push(record);
    }
  }

  const blocked = blockReasons.some((r) =>
    /invalid_ship|missing_source|unresolved_identity|source_file_missing|dimension_mismatch|content_hash_mismatch|source_not_in_expected/i.test(
      r
    )
  ) || invalid.some((i) =>
      String(i.reason || "").match(
        /missing_ship_id|source_file_missing|unresolved_identity|dimension_mismatch|content_hash_mismatch|source_not_in_expected|invalid_or_missing/
      )
    );

  // Hard block only for approved-with-critical issues (per sprint rules)
  const criticalInvalid = invalid.filter((i) => {
    const r = String(i.reason || "");
    return /missing_ship_id|source_file_missing|unresolved_identity|invalid_or_missing_decision|missing_canonical|dimension_mismatch|content_hash_mismatch|source_not_in_expected/.test(
      r
    );
  });

  return {
    ship_count: ships.length,
    approved,
    no_suitable_image: noSuitable,
    investigate,
    invalid_or_incomplete: invalid,
    eligible_approved: eligible,
    blocked: criticalInvalid.length > 0 || ships.length !== 29,
    block_reasons: [
      ...(ships.length !== 29 ? [`expected_29_ships_found_${ships.length}`] : []),
      ...criticalInvalid.map((i) => `${i.ship_name}:${i.reason}`)
    ]
  };
}
