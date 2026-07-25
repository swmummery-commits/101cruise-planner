/**
 * Gated Original-project (production) COPY safety checks.
 * Pure helpers — no network.
 */

export const PRODUCTION_COPY_CONFIRM_TOKEN = "PRINCESS";
export const PRODUCTION_COPY_ALLOWED_LINE_ID = "c19f40a7-c160-4035-a845-14dada550e1f";
export const PRODUCTION_COPY_MAX_CANDIDATES = 5;
export const PRODUCTION_COPY_MIN_CANDIDATES = 1;

/** Statuses that are allowed for a gated production copy candidate. */
const OK_STATUSES = new Set(["proposed_upload", "already_copied", "already_promoted", "already_on_supabase"]);

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
 */
export function assertProductionCopyCliGate({
  target,
  mode,
  projectRef,
  expectedProductionRef,
  scope,
  confirmToken
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
  if (confirmToken !== PRODUCTION_COPY_CONFIRM_TOKEN) {
    throw Object.assign(
      new Error(
        confirmToken == null || confirmToken === ""
          ? `REFUSED: production --copy requires --confirm-production-copy=${PRODUCTION_COPY_CONFIRM_TOKEN}`
          : `REFUSED: invalid --confirm-production-copy (expected ${PRODUCTION_COPY_CONFIRM_TOKEN})`
      ),
      { code: "production_copy_confirm_invalid" }
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
  if (String(scope.lineId) !== PRODUCTION_COPY_ALLOWED_LINE_ID) {
    throw Object.assign(
      new Error(
        `REFUSED: production --copy is limited to line-id ${PRODUCTION_COPY_ALLOWED_LINE_ID} (Princess Cruises)`
      ),
      { code: "production_copy_line_not_allowed" }
    );
  }
  return true;
}

/**
 * Post dry-run plan gate. All candidates must be valid; count 1–5; no CI URL changes.
 */
export function assertProductionCopyPlan({ inspected, summary, lineName }) {
  const items = inspected || [];
  if (items.length < PRODUCTION_COPY_MIN_CANDIDATES || items.length > PRODUCTION_COPY_MAX_CANDIDATES) {
    throw Object.assign(
      new Error(
        `REFUSED: production copy candidate count must be ${PRODUCTION_COPY_MIN_CANDIDATES}–${PRODUCTION_COPY_MAX_CANDIDATES}, got ${items.length}`
      ),
      { code: "production_copy_candidate_count" }
    );
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

  // Canonical URL changes must remain zero for copy phase
  const proposedCanonical = summary?.proposed_canonical_url_changes ?? 0;
  // proposed_canonical_url_changes in summariseInspection counts proposed promote targets;
  // copy must never apply them. Gate on explicit zero CI field mutations after copy.
  const estimatedBytes =
    summary?.estimated_upload_bytes ||
    summary?.estimated_download_bytes ||
    items.reduce((n, i) => n + (i.bytes || 0), 0);

  return {
    ok: true,
    line_name: lineName || null,
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
