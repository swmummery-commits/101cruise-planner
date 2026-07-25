/**
 * Approved Batch 1 — logo-only cruise lines (Original-project).
 * Order is fixed. Do not discover lines at runtime.
 */

export const BATCH_1_ID = "batch-1-logo-lines";
export const BATCH_1_CONFIRM_TOKEN = "BATCH-1-LOGOS";

export const BATCH_1_ADMIN_WARNING =
  "Close all open Cruise Database cruise-line and ship edit forms in 101cruise Admin. Reopen or hard-refresh the Admin after the batch completes.";

/**
 * Exact approved order. Names must match canonical ci_cruise_lines.name.
 */
export const BATCH_1_LINES = Object.freeze([
  Object.freeze({
    order: 1,
    name: "Norwegian Cruise Line",
    id: "c5f5361f-ebe5-4ff4-babe-7eb07f609bae"
  }),
  Object.freeze({
    order: 2,
    name: "Carnival Cruise Line",
    id: "dfc49fc6-42ed-44fa-b52a-0a48dd8fc6b6"
  }),
  Object.freeze({
    order: 3,
    name: "Silversea Cruises",
    id: "3fd46f63-8291-4090-8edf-8d1c79bf2846"
  }),
  Object.freeze({
    order: 4,
    name: "Seabourn Cruise Line",
    id: "efc86b9e-6ff9-4f09-80c7-1df4e25acaef"
  }),
  Object.freeze({
    order: 5,
    name: "MSC Cruises",
    id: "105d6d39-2495-46f2-aeb8-c22138084297"
  }),
  Object.freeze({
    order: 6,
    name: "Scenic Luxury Cruises & Tours",
    id: "e69635ab-cf1b-4c54-9de8-1cdfe6543a90"
  }),
  Object.freeze({
    order: 7,
    name: "Regent Seven Seas Cruises",
    id: "8f0859ad-32a4-44ce-8cef-7978199cc911"
  }),
  Object.freeze({
    order: 8,
    name: "Virgin Voyages",
    id: "99666d77-1975-4d24-9ac2-461c1fb8191a"
  }),
  Object.freeze({
    order: 9,
    name: "AMA Waterways",
    id: "3c27f17c-d555-4911-a346-27c35f111d57"
  }),
  Object.freeze({
    order: 10,
    name: "Viking Ocean Cruises",
    id: "85dbf68b-bfcc-448a-ae9d-7e3f74bd466c"
  }),
  Object.freeze({
    order: 11,
    name: "Emerald Cruises",
    id: "21ea265b-5dbb-422f-bf21-dccdc7f8e2a6"
  }),
  Object.freeze({
    order: 12,
    name: "Holland America Line",
    id: "a8d0e678-0cb2-4ea7-ad73-251f0eb36ea2"
  }),
  Object.freeze({
    order: 13,
    name: "Cunard Line",
    id: "33d66c61-8d02-4118-9717-d5c3c6aab52a"
  })
]);

export const BATCH_1_LINE_IDS = Object.freeze(BATCH_1_LINES.map((l) => l.id));

export function getApprovedBatch(batchId) {
  if (batchId === BATCH_1_ID) {
    return {
      id: BATCH_1_ID,
      confirm_token: BATCH_1_CONFIRM_TOKEN,
      lines: BATCH_1_LINES,
      expected_logo_count: 1,
      expected_ship_hero_count: 0,
      admin_warning: BATCH_1_ADMIN_WARNING
    };
  }
  return null;
}

/**
 * Abort before network when CLI args are wrong.
 */
export function assertProductionBatchCliGate({
  target,
  mode,
  batchId,
  confirmToken
}) {
  const allowedModes = new Set(["dry-run", "copy", "promote"]);
  if (!allowedModes.has(mode)) {
    throw Object.assign(new Error(`REFUSED: batch mode must be dry-run|copy|promote, got ${mode}`), {
      code: "batch_mode_invalid"
    });
  }
  if (target !== "production") {
    throw Object.assign(
      new Error("REFUSED: batch runner requires --target=production (DEV writes forbidden)"),
      { code: "batch_target_invalid" }
    );
  }
  if (!batchId) {
    throw Object.assign(new Error("REFUSED: missing --batch=<batch-id>"), {
      code: "batch_id_missing"
    });
  }
  const batch = getApprovedBatch(batchId);
  if (!batch) {
    throw Object.assign(new Error(`REFUSED: unknown or unapproved --batch=${batchId}`), {
      code: "batch_id_invalid"
    });
  }
  if (confirmToken == null || confirmToken === "") {
    throw Object.assign(
      new Error(`REFUSED: requires --confirm-production-batch=${batch.confirm_token}`),
      { code: "batch_confirm_invalid" }
    );
  }
  if (String(confirmToken) !== batch.confirm_token) {
    throw Object.assign(
      new Error(`REFUSED: invalid --confirm-production-batch (expected ${batch.confirm_token})`),
      { code: "batch_confirm_invalid" }
    );
  }
  return batch;
}

export function assertApprovedLineOrder(batch) {
  const lines = batch.lines || [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].order !== i + 1) {
      throw Object.assign(new Error("REFUSED: approved batch order is corrupted"), {
        code: "batch_order_invalid"
      });
    }
  }
  return true;
}

export function assertLineInApprovedBatch(batch, lineId) {
  const hit = (batch.lines || []).find((l) => String(l.id) === String(lineId));
  if (!hit) {
    throw Object.assign(new Error(`REFUSED: line ${lineId} is outside approved batch`), {
      code: "batch_line_not_approved"
    });
  }
  return hit;
}

/**
 * Resolve canonical row and confirm name/UUID match the approved entry.
 */
export function assertCanonicalLineMatch(approvedEntry, resolvedLine) {
  if (!resolvedLine) {
    throw Object.assign(
      new Error(`REFUSED: cruise line not found for ${approvedEntry.id}`),
      { code: "batch_line_missing" }
    );
  }
  if (String(resolvedLine.id) !== String(approvedEntry.id)) {
    throw Object.assign(new Error("REFUSED: resolved line UUID mismatch"), {
      code: "batch_line_uuid_mismatch"
    });
  }
  if (String(resolvedLine.name || "").trim() !== String(approvedEntry.name).trim()) {
    throw Object.assign(
      new Error(
        `REFUSED: unexpected line name for ${approvedEntry.id}: expected "${approvedEntry.name}", got "${resolvedLine.name}"`
      ),
      { code: "batch_line_name_mismatch" }
    );
  }
  return true;
}

/**
 * Batch 1 logo-only scope: exactly one logo candidate, zero ship heroes.
 */
export function assertBatch1LogoOnlyScope({ logoCandidates, shipHeroCandidates, lineName }) {
  const logos = logoCandidates || [];
  const ships = shipHeroCandidates || [];
  if (ships.length > 0) {
    throw Object.assign(
      new Error(
        `REFUSED: ${lineName || "line"} has ${ships.length} Squarespace ship hero(s); Batch 1 allows logos only`
      ),
      { code: "batch_ship_candidate_forbidden" }
    );
  }
  if (logos.length !== 1) {
    throw Object.assign(
      new Error(
        `REFUSED: ${lineName || "line"} must have exactly 1 Squarespace logo candidate, got ${logos.length}`
      ),
      { code: "batch_logo_candidate_count" }
    );
  }
  return true;
}
