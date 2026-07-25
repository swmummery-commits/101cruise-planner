/**
 * Gated Original-project (production) single-cruise-line PROMOTE safety checks.
 * Confirmation token must be the exact cruise-line UUID (not a name).
 * Pure helpers — no network (except injected URL verifier used by CLI).
 */

import { isSquarespaceHost } from "./url-safety.js";
import { applyVerifiedSequentialUpdates } from "./verified-ci-patch.js";

export const PRODUCTION_PROMOTE_MAX_CANDIDATES = 10;
export const PRODUCTION_PROMOTE_MIN_CANDIDATES = 1;

/** Historical Princess constants (still valid under the general UUID gate). */
export const PRODUCTION_PROMOTE_ALLOWED_LINE_ID = "c19f40a7-c160-4035-a845-14dada550e1f";
export const PRODUCTION_PROMOTE_ALLOWED_LINE_NAME = "Princess Cruises";
export const PRODUCTION_PROMOTE_ALLOWED_SHIP_NAME = "Crown Princess";
/** @deprecated use UUID confirmation equal to --line-id */
export const PRODUCTION_PROMOTE_CONFIRM_TOKEN = "PRINCESS";

export const PRODUCTION_PROMOTE_ADMIN_WARNING =
  "Close any open Cruise Database edit form for this cruise line and its affected ships before continuing. Reopen or hard-refresh the Admin after promotion.";

/**
 * Parse --confirm-production-promote=TOKEN or --confirm-production-promote TOKEN
 */
export function parseConfirmProductionPromote(argv = process.argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--confirm-production-promote") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) return null;
      return String(next);
    }
    if (arg.startsWith("--confirm-production-promote=")) {
      return arg.slice("--confirm-production-promote=".length);
    }
  }
  return null;
}

export function assertProductionPromoteCliGate({
  target,
  mode,
  projectRef,
  expectedProductionRef,
  scope,
  confirmToken,
  line = undefined
}) {
  if (target !== "production" || mode !== "promote") {
    throw Object.assign(
      new Error("Production promote gate only applies to --promote --target=production"),
      { code: "not_production_promote" }
    );
  }
  if (projectRef !== expectedProductionRef) {
    throw Object.assign(
      new Error(`Production promote refused: project ref must be ${expectedProductionRef}`),
      { code: "unexpected_production_ref" }
    );
  }
  if (!scope?.lineId || String(scope.lineId).trim() === "") {
    throw Object.assign(new Error("REFUSED: production --promote requires exactly one --line-id"), {
      code: "production_promote_scope_invalid"
    });
  }
  if (scope.shipId) {
    throw Object.assign(new Error("REFUSED: production --promote does not allow --ship-id"), {
      code: "production_promote_scope_invalid"
    });
  }
  if (scope.entityIds && scope.entityIds.length) {
    throw Object.assign(new Error("REFUSED: production --promote does not allow --ids broad scope"), {
      code: "production_promote_scope_invalid"
    });
  }
  if (confirmToken == null || confirmToken === "") {
    throw Object.assign(
      new Error(
        "REFUSED: production --promote requires --confirm-production-promote=<LINE_UUID> matching --line-id"
      ),
      { code: "production_promote_confirm_invalid" }
    );
  }
  if (String(confirmToken) !== String(scope.lineId)) {
    throw Object.assign(
      new Error(
        "REFUSED: --confirm-production-promote must exactly equal --line-id (cruise-line UUID)"
      ),
      { code: "production_promote_confirm_invalid" }
    );
  }
  if (line === null || (line !== undefined && !line)) {
    throw Object.assign(new Error("REFUSED: cruise line not found for --line-id"), {
      code: "production_promote_line_missing"
    });
  }
  if (line && String(line.id) !== String(scope.lineId)) {
    throw Object.assign(new Error("REFUSED: resolved cruise line id does not match --line-id"), {
      code: "production_promote_line_mismatch"
    });
  }
  return true;
}

function hasHash(value) {
  return Boolean(value && String(value).trim().length >= 32);
}

function migrationMediaForLine(mediaRows, lineId) {
  return (mediaRows || []).filter((m) => {
    if (String(m.cruise_line_id) !== String(lineId)) return false;
    if (!hasHash(m.content_hash)) return false;
    if (!m.source_url || !isSquarespaceHost(m.source_url)) return false;
    if (m.import_source && m.import_source !== "squarespace_ci_migration") return false;
    return true;
  });
}

function assertMediaRow(row, label) {
  if (!hasHash(row.content_hash)) {
    throw Object.assign(new Error(`REFUSED: ${label} media missing content_hash`), {
      code: "production_promote_missing_hash"
    });
  }
  if (!row.public_url || !String(row.public_url).includes("supabase")) {
    throw Object.assign(new Error(`REFUSED: ${label} media missing Supabase public_url`), {
      code: "production_promote_missing_public_url"
    });
  }
  if (!row.source_url || !isSquarespaceHost(row.source_url)) {
    throw Object.assign(new Error(`REFUSED: ${label} media missing Squarespace source_url`), {
      code: "production_promote_missing_source_url"
    });
  }
  if (!row.storage_path) {
    throw Object.assign(new Error(`REFUSED: ${label} media missing storage_path`), {
      code: "production_promote_missing_storage_path"
    });
  }
}

/**
 * Build promote plan for any single cruise line from CI + media_library rows.
 * Includes Squarespace logo (if any) and Squarespace ship heroes for that line only.
 */
export function buildProductionPromotePlan({ line, ships, mediaRows, lineId }) {
  const resolvedLineId = lineId || line?.id;
  if (!line || !resolvedLineId || String(line.id) !== String(resolvedLineId)) {
    throw Object.assign(new Error("REFUSED: cruise line record missing for promote"), {
      code: "production_promote_line_missing"
    });
  }

  const lineShips = (ships || []).filter((s) => String(s.cruise_line_id) === String(line.id));
  const updates = [];
  const shipNames = [];

  if (line.logo_url && isSquarespaceHost(line.logo_url)) {
    const logoCandidates = migrationMediaForLine(mediaRows, line.id).filter(
      (m) => m.media_type === "cruise_line" && !m.ship_id
    );
    if (!logoCandidates.length) {
      throw Object.assign(new Error("REFUSED: missing verified Media Library record for line logo"), {
        code: "production_promote_missing_logo_media"
      });
    }
    const logoMedia =
      logoCandidates.find(
        (m) => String(m.source_url || "").trim() === String(line.logo_url || "").trim()
      ) || logoCandidates[0];
    assertMediaRow(logoMedia, "logo");
    if (String(line.logo_url || "").trim() !== String(logoMedia.source_url || "").trim()) {
      throw Object.assign(
        new Error("REFUSED: line.logo_url does not match logo media source_url (Squarespace)"),
        { code: "production_promote_source_mismatch" }
      );
    }
    updates.push({
      entity_type: "cruise_line",
      entity_uuid: line.id,
      entity_name: line.name,
      table: "ci_cruise_lines",
      field: "logo_url",
      original_url: line.logo_url,
      new_url: logoMedia.public_url,
      media_library_id: logoMedia.id,
      storage_path: logoMedia.storage_path,
      content_hash: logoMedia.content_hash,
      source_url: logoMedia.source_url
    });
  }

  for (const ship of lineShips) {
    if (!ship.hero_image_url || !isSquarespaceHost(ship.hero_image_url)) continue;
    const heroCandidates = migrationMediaForLine(mediaRows, line.id).filter(
      (m) =>
        m.media_type === "ship" &&
        String(m.ship_id) === String(ship.id) &&
        String(m.cruise_line_id) === String(line.id)
    );
    if (!heroCandidates.length) {
      throw Object.assign(
        new Error(`REFUSED: missing verified Media Library record for ship hero "${ship.name}"`),
        { code: "production_promote_missing_hero_media" }
      );
    }
    const heroMedia =
      heroCandidates.find(
        (m) => String(m.source_url || "").trim() === String(ship.hero_image_url || "").trim()
      ) || heroCandidates[0];
    if (String(heroMedia.cruise_line_id) !== String(line.id)) {
      throw Object.assign(new Error("REFUSED: ship hero Media Library row belongs to another line"), {
        code: "production_promote_foreign_line"
      });
    }
    if (String(ship.cruise_line_id) !== String(line.id)) {
      throw Object.assign(new Error("REFUSED: ship does not belong to selected cruise line"), {
        code: "production_promote_ship_relationship"
      });
    }
    assertMediaRow(heroMedia, `ship:${ship.name}`);
    if (String(ship.hero_image_url || "").trim() !== String(heroMedia.source_url || "").trim()) {
      throw Object.assign(
        new Error(
          `REFUSED: ship.hero_image_url does not match hero media source_url for "${ship.name}"`
        ),
        { code: "production_promote_source_mismatch" }
      );
    }
    shipNames.push(ship.name);
    updates.push({
      entity_type: "ship",
      entity_uuid: ship.id,
      entity_name: ship.name,
      table: "ci_cruise_ships",
      field: "hero_image_url",
      original_url: ship.hero_image_url,
      new_url: heroMedia.public_url,
      media_library_id: heroMedia.id,
      storage_path: heroMedia.storage_path,
      content_hash: heroMedia.content_hash,
      source_url: heroMedia.source_url
    });
  }

  if (
    updates.length < PRODUCTION_PROMOTE_MIN_CANDIDATES ||
    updates.length > PRODUCTION_PROMOTE_MAX_CANDIDATES
  ) {
    throw Object.assign(
      new Error(
        `REFUSED: production promote candidate count must be ${PRODUCTION_PROMOTE_MIN_CANDIDATES}–${PRODUCTION_PROMOTE_MAX_CANDIDATES}, got ${updates.length}`
      ),
      { code: "production_promote_media_count" }
    );
  }

  for (const u of updates) {
    if (String(u.entity_type) === "cruise_line" && String(u.entity_uuid) !== String(line.id)) {
      throw Object.assign(new Error("REFUSED: promote update targets another cruise line"), {
        code: "production_promote_foreign_line"
      });
    }
    if (
      !(
        (u.table === "ci_cruise_lines" && u.field === "logo_url") ||
        (u.table === "ci_cruise_ships" && u.field === "hero_image_url")
      )
    ) {
      throw Object.assign(new Error("REFUSED: unexpected promote field"), {
        code: "production_promote_field_not_allowed"
      });
    }
  }

  const estimatedBytes = 0;

  return {
    line_id: line.id,
    line_name: line.name || "(unknown)",
    ship_ids: updates.filter((u) => u.entity_type === "ship").map((u) => u.entity_uuid),
    ship_names: shipNames,
    // backward-compatible single-ship fields when exactly one ship
    ship_id: shipNames.length === 1 ? updates.find((u) => u.entity_type === "ship")?.entity_uuid : null,
    ship_name: shipNames.length === 1 ? shipNames[0] : shipNames.join(", ") || null,
    candidate_count: updates.length,
    estimated_bytes: estimatedBytes,
    fields: updates.map((u) => `${u.table}.${u.field}`),
    updates,
    uploads: 0,
    media_library_inserts: 0,
    admin_stale_form_warning: PRODUCTION_PROMOTE_ADMIN_WARNING
  };
}

export async function assertProductionPromotePublicUrls(plan, verifyPublicUrl) {
  for (const u of plan.updates) {
    const ok = await verifyPublicUrl(u.new_url);
    if (!ok) {
      throw Object.assign(
        new Error(`REFUSED: Supabase public URL unreachable for ${u.entity_name} (${u.field})`),
        { code: "production_promote_public_url_unreachable" }
      );
    }
  }
  return true;
}

export function buildProductionPromoteManifest(plan, { projectRef, timestamp } = {}) {
  const migratedAt = timestamp || new Date().toISOString();
  const entries = plan.updates.map((u) => ({
    entity_type: u.entity_type,
    entity_uuid: u.entity_uuid,
    field_changed: u.field,
    original_url: u.original_url,
    new_url: u.new_url,
    media_library_id: u.media_library_id,
    storage_path: u.storage_path,
    content_hash: u.content_hash,
    migrated_timestamp: migratedAt
  }));

  const guardedRestoreCommand = [
    "node scripts/migrate-squarespace-ci-media.mjs \\",
    "  --rollback \\",
    "  --target=production \\",
    `  --line-id ${plan.line_id} \\`,
    `  --confirm-production-rollback=${plan.line_id} \\`,
    "  --manifest <path-to-this-manifest>"
  ].join("\n");

  return {
    kind: "production_promote_single_line",
    project_ref: projectRef || null,
    line_id: plan.line_id,
    ship_ids: plan.ship_ids || [],
    note: "Broad Original-project rollback is NOT enabled. Restore requires separate approval.",
    guarded_restore_command: guardedRestoreCommand,
    admin_stale_form_warning: PRODUCTION_PROMOTE_ADMIN_WARNING,
    entries
  };
}

export function formatProductionPromoteBanner(plan, projectRef) {
  const ships =
    (plan.ship_names && plan.ship_names.length
      ? plan.ship_names.join(", ")
      : plan.ship_name) || "(none)";
  return [
    "=== PRODUCTION PROMOTE CONFIRMATION ===",
    "target: Original project",
    `project_ref: ${projectRef}`,
    `cruise line name: ${plan.line_name}`,
    `cruise line UUID: ${plan.line_id}`,
    `affected ships: ${ships}`,
    `candidate count: ${plan.candidate_count}`,
    `estimated bytes: ${plan.estimated_bytes ?? 0}`,
    `fields proposed for update: ${(plan.fields || []).join(", ")}`,
    "uploads during promote: 0",
    "Media Library inserts during promote: 0",
    "strategy: verified sequential update with compensating rollback",
    "",
    `WARNING: ${PRODUCTION_PROMOTE_ADMIN_WARNING}`
  ].join("\n");
}

/**
 * Apply promote updates with verified PATCH + re-read and compensating rollback.
 * Not a database transaction.
 */
export async function applyVerifiedSequentialProductionPromote(plan, { verifiedWrite }) {
  return applyVerifiedSequentialUpdates(plan.updates, { verifiedWrite });
}

/** @deprecated use applyVerifiedSequentialProductionPromote */
export const applyAtomicProductionPromote = applyVerifiedSequentialProductionPromote;
