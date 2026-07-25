/**
 * Gated Original-project (production) PROMOTE safety checks + atomic apply helpers.
 * Pure helpers — no network (except injected URL verifier used by CLI).
 */

import { isSquarespaceHost } from "./url-safety.js";

export const PRODUCTION_PROMOTE_CONFIRM_TOKEN = "PRINCESS";
export const PRODUCTION_PROMOTE_ALLOWED_LINE_ID = "c19f40a7-c160-4035-a845-14dada550e1f";
export const PRODUCTION_PROMOTE_ALLOWED_LINE_NAME = "Princess Cruises";
export const PRODUCTION_PROMOTE_ALLOWED_SHIP_NAME = "Crown Princess";
export const PRODUCTION_PROMOTE_EXPECTED_COUNT = 2;

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
  confirmToken
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
  if (confirmToken !== PRODUCTION_PROMOTE_CONFIRM_TOKEN) {
    throw Object.assign(
      new Error(
        confirmToken == null || confirmToken === ""
          ? `REFUSED: production --promote requires --confirm-production-promote=${PRODUCTION_PROMOTE_CONFIRM_TOKEN}`
          : `REFUSED: invalid --confirm-production-promote (expected ${PRODUCTION_PROMOTE_CONFIRM_TOKEN})`
      ),
      { code: "production_promote_confirm_invalid" }
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
  if (String(scope.lineId) !== PRODUCTION_PROMOTE_ALLOWED_LINE_ID) {
    throw Object.assign(
      new Error(
        `REFUSED: production --promote is limited to line-id ${PRODUCTION_PROMOTE_ALLOWED_LINE_ID}`
      ),
      { code: "production_promote_line_not_allowed" }
    );
  }
  return true;
}

function hasHash(value) {
  return Boolean(value && String(value).trim().length >= 32);
}

/**
 * Build the exact two-field promote plan from loaded CI + media_library rows.
 * Does not perform network I/O.
 */
export function buildProductionPromotePlan({ line, ships, mediaRows }) {
  if (!line || String(line.id) !== PRODUCTION_PROMOTE_ALLOWED_LINE_ID) {
    throw Object.assign(new Error("REFUSED: Princess Cruises line record missing"), {
      code: "production_promote_line_missing"
    });
  }

  const ship = (ships || []).find(
    (s) =>
      String(s.cruise_line_id) === PRODUCTION_PROMOTE_ALLOWED_LINE_ID &&
      String(s.name || "").trim() === PRODUCTION_PROMOTE_ALLOWED_SHIP_NAME
  );
  if (!ship) {
    throw Object.assign(
      new Error(`REFUSED: ship "${PRODUCTION_PROMOTE_ALLOWED_SHIP_NAME}" not found under Princess`),
      { code: "production_promote_ship_missing" }
    );
  }

  // Count only migration-sourced Princess records (Squarespace source_url + hash).
  const lineMedia = (mediaRows || []).filter((m) => {
    if (String(m.cruise_line_id) !== PRODUCTION_PROMOTE_ALLOWED_LINE_ID) return false;
    if (!hasHash(m.content_hash)) return false;
    if (!m.source_url || !isSquarespaceHost(m.source_url)) return false;
    if (m.import_source && m.import_source !== "squarespace_ci_migration") return false;
    return true;
  });
  // Exactly two verified records for this line (logo + Crown Princess hero)
  if (lineMedia.length !== PRODUCTION_PROMOTE_EXPECTED_COUNT) {
    throw Object.assign(
      new Error(
        `REFUSED: expected exactly ${PRODUCTION_PROMOTE_EXPECTED_COUNT} verified media_library records for Princess, got ${lineMedia.length}`
      ),
      { code: "production_promote_media_count" }
    );
  }

  const logoMedia = lineMedia.find(
    (m) =>
      m.media_type === "cruise_line" &&
      !m.ship_id &&
      String(m.cruise_line_id) === PRODUCTION_PROMOTE_ALLOWED_LINE_ID
  );
  const heroMedia = lineMedia.find(
    (m) =>
      m.media_type === "ship" &&
      String(m.ship_id) === String(ship.id) &&
      String(m.cruise_line_id) === PRODUCTION_PROMOTE_ALLOWED_LINE_ID
  );

  if (!logoMedia) {
    throw Object.assign(new Error("REFUSED: missing Princess logo media_library record"), {
      code: "production_promote_missing_logo_media"
    });
  }
  if (!heroMedia) {
    throw Object.assign(
      new Error("REFUSED: missing Crown Princess hero media_library record (relationship)"),
      { code: "production_promote_missing_hero_media" }
    );
  }

  for (const [label, row] of [
    ["logo", logoMedia],
    ["hero", heroMedia]
  ]) {
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

  if (String(line.logo_url || "").trim() !== String(logoMedia.source_url || "").trim()) {
    throw Object.assign(
      new Error("REFUSED: line.logo_url does not match logo media source_url (Squarespace)"),
      { code: "production_promote_source_mismatch" }
    );
  }
  if (String(ship.hero_image_url || "").trim() !== String(heroMedia.source_url || "").trim()) {
    throw Object.assign(
      new Error("REFUSED: ship.hero_image_url does not match hero media source_url (Squarespace)"),
      { code: "production_promote_source_mismatch" }
    );
  }

  const updates = [
    {
      entity_type: "cruise_line",
      entity_uuid: line.id,
      entity_name: line.name || PRODUCTION_PROMOTE_ALLOWED_LINE_NAME,
      table: "ci_cruise_lines",
      field: "logo_url",
      original_url: line.logo_url,
      new_url: logoMedia.public_url,
      media_library_id: logoMedia.id,
      storage_path: logoMedia.storage_path,
      content_hash: logoMedia.content_hash,
      source_url: logoMedia.source_url
    },
    {
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
    }
  ];

  // Only these two fields may update
  for (const u of updates) {
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

  return {
    line_id: line.id,
    line_name: line.name || PRODUCTION_PROMOTE_ALLOWED_LINE_NAME,
    ship_id: ship.id,
    ship_name: ship.name,
    candidate_count: updates.length,
    updates,
    uploads: 0,
    media_library_inserts: 0
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
    `  --line-id ${PRODUCTION_PROMOTE_ALLOWED_LINE_ID} \\`,
    "  --confirm-production-rollback=PRINCESS \\",
    "  --manifest <path-to-this-manifest>"
  ].join("\n");

  return {
    kind: "production_promote_princess",
    project_ref: projectRef || null,
    line_id: plan.line_id,
    ship_id: plan.ship_id,
    note: "Broad Original-project rollback is NOT enabled. Restore requires separate approval of the guarded Princess-only rollback command below.",
    guarded_restore_command: guardedRestoreCommand,
    entries
  };
}

export function formatProductionPromoteBanner(plan, projectRef) {
  return [
    "=== PRODUCTION PROMOTE CONFIRMATION ===",
    "target: Original project",
    `project_ref: ${projectRef}`,
    `cruise line: ${plan.line_name} (${plan.line_id})`,
    `ship: ${plan.ship_name} (${plan.ship_id})`,
    `candidate count: ${plan.candidate_count}`,
    "fields: ci_cruise_lines.logo_url, ci_cruise_ships.hero_image_url",
    "uploads: 0",
    "media_library inserts: 0",
    "atomic: all-or-nothing"
  ].join("\n");
}

/**
 * Apply exactly two CI URL patches with restore-on-failure.
 * patchCiField({ table, id, field, value })
 */
export async function applyAtomicProductionPromote(plan, { patchCiField }) {
  const applied = [];
  try {
    for (const u of plan.updates) {
      await patchCiField({
        table: u.table,
        id: u.entity_uuid,
        field: u.field,
        value: u.new_url
      });
      applied.push(u);
    }
    return { ok: true, applied, restored: [] };
  } catch (error) {
    const restored = [];
    for (const u of [...applied].reverse()) {
      try {
        await patchCiField({
          table: u.table,
          id: u.entity_uuid,
          field: u.field,
          value: u.original_url
        });
        restored.push(u);
      } catch (restoreError) {
        throw Object.assign(
          new Error(
            `PARTIAL PROMOTE FAILURE: ${error.message}. Restore also failed for ${u.field}: ${restoreError.message}`
          ),
          { code: "production_promote_partial_restore_failed", cause: error }
        );
      }
    }
    throw Object.assign(
      new Error(
        `PROMOTE FAILED — rolled back ${restored.length} update(s). Original error: ${error.message}`
      ),
      { code: "production_promote_rolled_back", restored, cause: error }
    );
  }
}
