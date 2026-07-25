/**
 * Gated Original-project (production) single-cruise-line COPY safety checks.
 * Confirmation token must be the exact cruise-line UUID (not a name).
 * Pure helpers — no network.
 */

export const PRODUCTION_COPY_MAX_CANDIDATES = 10;
export const PRODUCTION_COPY_MIN_CANDIDATES = 1;

/** @deprecated Princess-era constant — UUID confirmation is now required. */
export const PRODUCTION_COPY_CONFIRM_TOKEN = "PRINCESS";
/** Historical Princess line id (still a valid general-gate line UUID). */
export const PRODUCTION_COPY_ALLOWED_LINE_ID = "c19f40a7-c160-4035-a845-14dada550e1f";

/** Statuses that are allowed for a gated production copy candidate. */
const OK_STATUSES = new Set([
  "proposed_upload",
  "already_copied",
  "already_promoted",
  "already_on_supabase"
]);

/**
 * Parse --confirm-production-copy=TOKEN or --confirm-production-copy TOKEN
 */
export function parseConfirmProductionCopy(argv = process.argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--confirm-production-copy") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) return null;
      return String(next);
    }
    if (arg.startsWith("--confirm-production-copy=")) {
      return arg.slice("--confirm-production-copy=".length);
    }
  }
  return null;
}

/**
 * CLI / scope gate before any production copy write.
 * confirmToken must exactly equal scope.lineId (UUID).
 * Pass `line` (ci_cruise_lines row) to require the line exists.
 */
export function assertProductionCopyCliGate({
  target,
  mode,
  projectRef,
  expectedProductionRef,
  scope,
  confirmToken,
  line = undefined
}) {
  if (target !== "production" || mode !== "copy") {
    throw Object.assign(new Error("Production copy gate only applies to --copy --target=production"), {
      code: "not_production_copy"
    });
  }
  if (projectRef !== expectedProductionRef) {
    throw Object.assign(
      new Error(`Production copy refused: project ref must be ${expectedProductionRef}`),
      { code: "unexpected_production_ref" }
    );
  }
  if (!scope?.lineId || String(scope.lineId).trim() === "") {
    throw Object.assign(new Error("REFUSED: production --copy requires exactly one --line-id"), {
      code: "production_copy_scope_invalid"
    });
  }
  if (scope.shipId) {
    throw Object.assign(new Error("REFUSED: production --copy does not allow --ship-id"), {
      code: "production_copy_scope_invalid"
    });
  }
  if (scope.entityIds && scope.entityIds.length) {
    throw Object.assign(new Error("REFUSED: production --copy does not allow --ids broad scope"), {
      code: "production_copy_scope_invalid"
    });
  }
  if (confirmToken == null || confirmToken === "") {
    throw Object.assign(
      new Error(
        `REFUSED: production --copy requires --confirm-production-copy=<LINE_UUID> matching --line-id`
      ),
      { code: "production_copy_confirm_invalid" }
    );
  }
  if (String(confirmToken) !== String(scope.lineId)) {
    throw Object.assign(
      new Error(
        "REFUSED: --confirm-production-copy must exactly equal --line-id (cruise-line UUID)"
      ),
      { code: "production_copy_confirm_invalid" }
    );
  }
  if (line === null || (line !== undefined && !line)) {
    throw Object.assign(new Error("REFUSED: cruise line not found for --line-id"), {
      code: "production_copy_line_missing"
    });
  }
  if (line && String(line.id) !== String(scope.lineId)) {
    throw Object.assign(new Error("REFUSED: resolved cruise line id does not match --line-id"), {
      code: "production_copy_line_mismatch"
    });
  }
  return true;
}

/**
 * Post dry-run plan gate. All candidates must be valid; count 1–10; same line; no CI URL changes.
 */
export function assertProductionCopyPlan({ inspected, summary, lineId, lineName }) {
  const items = inspected || [];
  if (items.length < PRODUCTION_COPY_MIN_CANDIDATES || items.length > PRODUCTION_COPY_MAX_CANDIDATES) {
    throw Object.assign(
      new Error(
        `REFUSED: production copy candidate count must be ${PRODUCTION_COPY_MIN_CANDIDATES}–${PRODUCTION_COPY_MAX_CANDIDATES}, got ${items.length}`
      ),
      { code: "production_copy_candidate_count" }
    );
  }

  if (lineId) {
    for (const item of items) {
      if (String(item.cruise_line_id) !== String(lineId)) {
        throw Object.assign(
          new Error(
            `REFUSED: production copy candidate ${item.entity_id} belongs to another cruise line`
          ),
          { code: "production_copy_foreign_line" }
        );
      }
    }
  }

  const bad = [];
  for (const item of items) {
    if (!OK_STATUSES.has(item.status)) {
      bad.push({ id: item.entity_id, status: item.status, error: item.error || null });
    }
    if (item.oversized) {
      bad.push({ id: item.entity_id, status: "oversized", error: "oversized asset" });
    }
  }
  if (summary?.broken_urls > 0) {
    throw Object.assign(new Error("REFUSED: production copy aborted — broken URL(s) in plan"), {
      code: "production_copy_broken_url"
    });
  }
  if (summary?.invalid_mime_types > 0) {
    throw Object.assign(new Error("REFUSED: production copy aborted — invalid MIME type(s)"), {
      code: "production_copy_invalid_mime"
    });
  }
  if (summary?.ssrf_blocked > 0) {
    throw Object.assign(new Error("REFUSED: production copy aborted — SSRF-blocked URL(s)"), {
      code: "production_copy_ssrf"
    });
  }
  if (summary?.too_large > 0 || bad.some((b) => b.status === "oversized")) {
    throw Object.assign(new Error("REFUSED: production copy aborted — oversized asset(s)"), {
      code: "production_copy_oversized"
    });
  }
  if (bad.length) {
    throw Object.assign(
      new Error(
        `REFUSED: production copy aborted — invalid candidate(s): ${bad
          .map((b) => `${b.id}:${b.status}`)
          .join(", ")}`
      ),
      { code: "production_copy_invalid_candidate", details: bad }
    );
  }

  const proposedCanonical = summary?.proposed_canonical_url_changes ?? 0;
  const estimatedBytes =
    summary?.estimated_upload_bytes ||
    summary?.estimated_download_bytes ||
    items.reduce((n, i) => n + (i.bytes || 0), 0);

  return {
    ok: true,
    line_name: lineName || null,
    line_id: lineId || null,
    candidate_count: items.length,
    estimated_bytes: estimatedBytes,
    proposed_canonical_url_changes_reported: proposedCanonical,
    canonical_url_changes_on_copy: 0
  };
}

export function formatProductionCopyBanner({
  projectRef,
  lineId,
  lineName,
  candidateCount,
  estimatedBytes
}) {
  return [
    "=== PRODUCTION COPY CONFIRMATION ===",
    "target: Original project",
    `project_ref: ${projectRef}`,
    `cruise line UUID: ${lineId}`,
    `cruise line name: ${lineName || "(unknown)"}`,
    `candidate count: ${candidateCount}`,
    `estimated bytes: ${estimatedBytes}`,
    "canonical URL changes: 0",
    "tables writable: media_library only",
    "storage writable: cruise-media only",
    "logo_url / hero_image_url: UNCHANGED"
  ].join("\n");
}

/**
 * Assert copy results never mutated CI URLs.
 */
export function assertCopyDidNotChangeCiUrls(copyResults) {
  for (const row of copyResults || []) {
    if (row.ci_url_changed === true) {
      throw Object.assign(new Error("REFUSED: copy attempted to change a CI URL"), {
        code: "production_copy_ci_url_changed"
      });
    }
  }
  return true;
}
