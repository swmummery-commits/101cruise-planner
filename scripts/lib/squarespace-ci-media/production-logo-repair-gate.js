/**
 * Gated Original-project Princess logo-only repair.
 * Pure helpers — no network (except injected URL verifier used by CLI).
 */

import { isSquarespaceHost } from "./url-safety.js";
import { PRODUCTION_REF } from "./target.js";

export const PRODUCTION_LOGO_REPAIR_CONFIRM_TOKEN = "PRINCESS";
export const PRODUCTION_LOGO_REPAIR_ALLOWED_LINE_ID = "c19f40a7-c160-4035-a845-14dada550e1f";
export const PRODUCTION_LOGO_REPAIR_ALLOWED_LINE_NAME = "Princess Cruises";
export const PRODUCTION_LOGO_REPAIR_CROWN_SHIP_ID = "bbde7c14-3ce4-4413-9a1d-ce96f627a254";

export const ADMIN_STALE_FORM_WARNING =
  "Close any open Princess Cruises edit form in 101cruise Admin before running the repair, then reopen or hard-refresh it afterward, so stale form data cannot overwrite the repaired logo.";

function hasHash(value) {
  return Boolean(value && String(value).trim().length >= 32);
}

/**
 * Parse --confirm-production-logo-repair=TOKEN
 */
export function parseConfirmProductionLogoRepair(argv = process.argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--confirm-production-logo-repair") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) return null;
      return String(next);
    }
    if (arg.startsWith("--confirm-production-logo-repair=")) {
      return arg.slice("--confirm-production-logo-repair=".length);
    }
  }
  return null;
}

export function assertProductionLogoRepairCliGate({
  target,
  mode,
  projectRef,
  expectedProductionRef,
  scope,
  confirmToken
}) {
  if (target !== "production" || mode !== "repair-logo") {
    throw Object.assign(
      new Error("Production logo repair gate only applies to --repair-logo --target=production"),
      { code: "not_production_logo_repair" }
    );
  }
  if (projectRef !== expectedProductionRef) {
    throw Object.assign(
      new Error(`Production logo repair refused: project ref must be ${expectedProductionRef}`),
      { code: "unexpected_production_ref" }
    );
  }
  if (confirmToken !== PRODUCTION_LOGO_REPAIR_CONFIRM_TOKEN) {
    throw Object.assign(
      new Error(
        confirmToken == null || confirmToken === ""
          ? `REFUSED: production --repair-logo requires --confirm-production-logo-repair=${PRODUCTION_LOGO_REPAIR_CONFIRM_TOKEN}`
          : `REFUSED: invalid --confirm-production-logo-repair (expected ${PRODUCTION_LOGO_REPAIR_CONFIRM_TOKEN})`
      ),
      { code: "production_logo_repair_confirm_invalid" }
    );
  }
  if (!scope?.lineId || String(scope.lineId).trim() === "") {
    throw Object.assign(new Error("REFUSED: production --repair-logo requires exactly one --line-id"), {
      code: "production_logo_repair_scope_invalid"
    });
  }
  if (scope.shipId) {
    throw Object.assign(new Error("REFUSED: production --repair-logo does not allow --ship-id"), {
      code: "production_logo_repair_scope_invalid"
    });
  }
  if (scope.entityIds && scope.entityIds.length) {
    throw Object.assign(new Error("REFUSED: production --repair-logo does not allow --ids broad scope"), {
      code: "production_logo_repair_scope_invalid"
    });
  }
  if (String(scope.lineId) !== PRODUCTION_LOGO_REPAIR_ALLOWED_LINE_ID) {
    throw Object.assign(
      new Error(
        `REFUSED: production --repair-logo is limited to line-id ${PRODUCTION_LOGO_REPAIR_ALLOWED_LINE_ID}`
      ),
      { code: "production_logo_repair_line_not_allowed" }
    );
  }
  return true;
}

/**
 * Build a one-field logo repair plan. Never includes ship updates.
 */
export function buildProductionLogoRepairPlan({ line, mediaRows }) {
  if (!line || String(line.id) !== PRODUCTION_LOGO_REPAIR_ALLOWED_LINE_ID) {
    throw Object.assign(new Error("REFUSED: Princess Cruises line record missing"), {
      code: "production_logo_repair_line_missing"
    });
  }

  const logoMedia = (mediaRows || []).find(
    (m) =>
      m.media_type === "cruise_line" &&
      !m.ship_id &&
      String(m.cruise_line_id) === PRODUCTION_LOGO_REPAIR_ALLOWED_LINE_ID &&
      hasHash(m.content_hash) &&
      m.source_url &&
      isSquarespaceHost(m.source_url) &&
      (!m.import_source || m.import_source === "squarespace_ci_migration")
  );

  if (!logoMedia) {
    throw Object.assign(new Error("REFUSED: missing verified Princess logo media_library record"), {
      code: "production_logo_repair_missing_media"
    });
  }
  if (!hasHash(logoMedia.content_hash)) {
    throw Object.assign(new Error("REFUSED: logo media missing content_hash"), {
      code: "production_logo_repair_missing_hash"
    });
  }
  if (!logoMedia.public_url || !String(logoMedia.public_url).includes("supabase")) {
    throw Object.assign(new Error("REFUSED: logo media missing Original-project Supabase public_url"), {
      code: "production_logo_repair_missing_public_url"
    });
  }
  try {
    const ref = new URL(logoMedia.public_url).hostname.split(".")[0];
    if (ref !== PRODUCTION_REF) {
      throw Object.assign(
        new Error(`REFUSED: logo public_url is not Original project (${PRODUCTION_REF})`),
        { code: "production_logo_repair_wrong_project_url" }
      );
    }
  } catch (e) {
    if (e.code) throw e;
    throw Object.assign(new Error("REFUSED: logo public_url is not a valid URL"), {
      code: "production_logo_repair_invalid_public_url"
    });
  }
  if (!logoMedia.source_url || !isSquarespaceHost(logoMedia.source_url)) {
    throw Object.assign(new Error("REFUSED: logo media missing Squarespace source_url"), {
      code: "production_logo_repair_missing_source_url"
    });
  }
  if (String(line.logo_url || "").trim() !== String(logoMedia.source_url || "").trim()) {
    throw Object.assign(
      new Error("REFUSED: current logo_url does not match media source_url (Squarespace)"),
      { code: "production_logo_repair_source_mismatch" }
    );
  }

  const update = {
    entity_type: "cruise_line",
    entity_uuid: line.id,
    entity_name: line.name || PRODUCTION_LOGO_REPAIR_ALLOWED_LINE_NAME,
    table: "ci_cruise_lines",
    field: "logo_url",
    original_url: line.logo_url,
    new_url: logoMedia.public_url,
    media_library_id: logoMedia.id,
    storage_path: logoMedia.storage_path,
    content_hash: logoMedia.content_hash,
    source_url: logoMedia.source_url
  };

  if (update.table !== "ci_cruise_lines" || update.field !== "logo_url") {
    throw Object.assign(new Error("REFUSED: repair may only update ci_cruise_lines.logo_url"), {
      code: "production_logo_repair_field_not_allowed"
    });
  }
  if (String(update.entity_uuid) === PRODUCTION_LOGO_REPAIR_CROWN_SHIP_ID) {
    throw Object.assign(new Error("REFUSED: repair must not target Crown Princess ship"), {
      code: "production_logo_repair_ship_forbidden"
    });
  }

  return {
    line_id: line.id,
    line_name: line.name || PRODUCTION_LOGO_REPAIR_ALLOWED_LINE_NAME,
    candidate_count: 1,
    updates: [update],
    uploads: 0,
    media_library_inserts: 0,
    ships_updated: 0,
    admin_stale_form_warning: ADMIN_STALE_FORM_WARNING
  };
}

export async function assertProductionLogoRepairPublicUrl(plan, verifyPublicUrl) {
  const u = plan.updates[0];
  const ok = await verifyPublicUrl(u.new_url);
  if (!ok) {
    throw Object.assign(new Error("REFUSED: Supabase logo public URL unreachable"), {
      code: "production_logo_repair_public_url_unreachable"
    });
  }
  return true;
}

export function buildProductionLogoRepairManifest(plan, { projectRef, timestamp } = {}) {
  const migratedAt = timestamp || new Date().toISOString();
  const u = plan.updates[0];
  return {
    kind: "production_logo_repair_princess",
    project_ref: projectRef || null,
    line_id: plan.line_id,
    note: "One-field logo repair only. Broad Original-project rollback remains blocked.",
    admin_stale_form_warning: ADMIN_STALE_FORM_WARNING,
    entries: [
      {
        entity_type: u.entity_type,
        entity_uuid: u.entity_uuid,
        field_changed: u.field,
        original_url: u.original_url,
        new_url: u.new_url,
        media_library_id: u.media_library_id,
        storage_path: u.storage_path,
        content_hash: u.content_hash,
        migrated_timestamp: migratedAt
      }
    ]
  };
}

export function formatProductionLogoRepairBanner(plan, projectRef) {
  return [
    "=== PRODUCTION LOGO REPAIR CONFIRMATION ===",
    "target: Original project",
    `project_ref: ${projectRef}`,
    `cruise line: ${plan.line_name} (${plan.line_id})`,
    "fields: ci_cruise_lines.logo_url only",
    "ships updated: 0",
    "uploads: 0",
    "media_library inserts: 0",
    "strategy: verified sequential update with compensating rollback",
    "",
    `WARNING: ${ADMIN_STALE_FORM_WARNING}`
  ].join("\n");
}
