/**
 * Approved Batch 3 — Disney Cruise Line only (Original-project).
 * Final remaining Squarespace CI media batch.
 *
 * Source of truth for UUID/name/counts/ships: dry-run report
 * tmp/squarespace-migration/dry-run-1784951494180.json
 */

export const BATCH_3_ID = "batch-3-disney";
export const BATCH_3_CONFIRM_TOKEN = "BATCH-3-DISNEY";

export const BATCH_3_ADMIN_WARNING =
  "Close all open Cruise Database cruise-line and ship edit forms in 101cruise Admin. Reopen or hard-refresh the Admin after the batch completes.";

export const DISNEY_CRUISE_LINE_ID = "8f7aadcb-7843-4060-b0cb-a60631936b3a";
export const DISNEY_CRUISE_LINE_NAME = "Disney Cruise Line";

/**
 * Exact approved Disney line. Names/UUIDs/counts/ships from Original dry-run.
 */
export const BATCH_3_LINES = Object.freeze([
  Object.freeze({
    order: 1,
    name: DISNEY_CRUISE_LINE_NAME,
    id: DISNEY_CRUISE_LINE_ID,
    expected_logo_count: 1,
    expected_ship_hero_count: 7,
    expected_total: 8,
    ships: Object.freeze([
      Object.freeze({
        id: "5d979176-6c7d-4108-8a76-6f8ccb7da18f",
        name: "Disney Magic"
      }),
      Object.freeze({
        id: "650db17c-7f0e-40c9-8385-c50b6234d6cb",
        name: "Disney Adventure"
      }),
      Object.freeze({
        id: "72ecb1ad-bafd-43de-93e5-cbfb56b6b896",
        name: "Disney Wish"
      }),
      Object.freeze({
        id: "962ec1fe-1284-47a7-9e0f-f14f514ee53f",
        name: "Disney Treasure"
      }),
      Object.freeze({
        id: "9ffe68ea-02d0-4d62-b74b-60f0f41bda2f",
        name: "Disney Fantasy"
      }),
      Object.freeze({
        id: "ebf469d3-d359-4bc8-a28a-950c3e12735b",
        name: "Disney Dream"
      }),
      Object.freeze({
        id: "f4548e16-5c16-4722-a5e7-e75fd9e49d00",
        name: "Disney Wonder"
      })
    ])
  })
]);

export const BATCH_3_LINE_IDS = Object.freeze(BATCH_3_LINES.map((l) => l.id));
export const BATCH_3_SHIP_IDS = Object.freeze(
  BATCH_3_LINES.flatMap((l) => l.ships.map((s) => s.id))
);

export function getBatch3Config() {
  return {
    id: BATCH_3_ID,
    confirm_token: BATCH_3_CONFIRM_TOKEN,
    kind: "mixed",
    lines: BATCH_3_LINES,
    admin_warning: BATCH_3_ADMIN_WARNING,
    excludes_disney: false,
    disney_only: true,
    disney_line_id: DISNEY_CRUISE_LINE_ID,
    expected_total_assets: 8
  };
}

/**
 * Validate Batch 3 Disney Squarespace scope against fixed configuration.
 *
 * @param {{
 *   approved: object,
 *   logoCandidates: Array<{url?: string, cruise_line_id?: string}>,
 *   shipHeroCandidates: Array<{ship_id: string, name: string, cruise_line_id?: string, url?: string}>
 * }} opts
 */
export function assertBatch3DisneyScope({ approved, logoCandidates, shipHeroCandidates }) {
  const logos = logoCandidates || [];
  const ships = shipHeroCandidates || [];

  if (String(approved.id) !== DISNEY_CRUISE_LINE_ID) {
    throw Object.assign(
      new Error(`REFUSED: Batch 3 only allows Disney Cruise Line, got ${approved.id}`),
      { code: "batch3_non_disney_line" }
    );
  }
  if (String(approved.name || "").trim() !== DISNEY_CRUISE_LINE_NAME) {
    throw Object.assign(
      new Error(
        `REFUSED: Batch 3 canonical name mismatch: expected "${DISNEY_CRUISE_LINE_NAME}", got "${approved.name}"`
      ),
      { code: "batch3_name_mismatch" }
    );
  }

  if (logos.length !== approved.expected_logo_count) {
    throw Object.assign(
      new Error(
        `REFUSED: Disney unexpected logo count: expected ${approved.expected_logo_count}, got ${logos.length}`
      ),
      { code: "batch3_unexpected_logo_count" }
    );
  }
  if (ships.length !== approved.expected_ship_hero_count) {
    throw Object.assign(
      new Error(
        `REFUSED: Disney unexpected ship-hero count: expected ${approved.expected_ship_hero_count}, got ${ships.length}`
      ),
      { code: "batch3_unexpected_ship_count" }
    );
  }
  const total = logos.length + ships.length;
  if (total !== 8 || total !== approved.expected_total) {
    throw Object.assign(
      new Error(`REFUSED: Disney unexpected total candidates: expected 8, got ${total}`),
      { code: "batch3_unexpected_total_count" }
    );
  }

  for (const logo of logos) {
    if (logo.cruise_line_id != null && String(logo.cruise_line_id) !== DISNEY_CRUISE_LINE_ID) {
      throw Object.assign(new Error("REFUSED: logo candidate belongs to another cruise line"), {
        code: "batch3_foreign_candidate"
      });
    }
  }

  const expectedNames = new Set(approved.ships.map((s) => s.name));
  const expectedIds = new Set(approved.ships.map((s) => String(s.id)));
  const actualNames = new Set(ships.map((s) => s.name));
  const actualIds = new Set(ships.map((s) => String(s.ship_id)));

  for (const name of expectedNames) {
    if (!actualNames.has(name)) {
      throw Object.assign(new Error(`REFUSED: Disney missing expected ship "${name}"`), {
        code: "batch3_missing_ship"
      });
    }
  }
  for (const name of actualNames) {
    if (!expectedNames.has(name)) {
      throw Object.assign(new Error(`REFUSED: Disney unexpected ship name "${name}"`), {
        code: "batch3_unexpected_ship_name"
      });
    }
  }
  for (const id of expectedIds) {
    if (!actualIds.has(id)) {
      throw Object.assign(new Error(`REFUSED: Disney missing expected ship UUID ${id}`), {
        code: "batch3_missing_ship"
      });
    }
  }
  for (const id of actualIds) {
    if (!expectedIds.has(id)) {
      throw Object.assign(new Error(`REFUSED: Disney unexpected ship UUID ${id}`), {
        code: "batch3_unexpected_ship_id"
      });
    }
  }

  for (const s of ships) {
    if (s.cruise_line_id != null && String(s.cruise_line_id) !== DISNEY_CRUISE_LINE_ID) {
      throw Object.assign(
        new Error(`REFUSED: ship ${s.ship_id} belongs to another cruise line`),
        { code: "batch3_foreign_candidate" }
      );
    }
    const match = approved.ships.find((a) => String(a.id) === String(s.ship_id));
    if (!match) {
      throw Object.assign(
        new Error(`REFUSED: ship ${s.ship_id} is not an approved Disney ship`),
        { code: "batch3_ship_not_approved" }
      );
    }
    if (match.name !== s.name) {
      throw Object.assign(
        new Error(
          `REFUSED: ship UUID ${s.ship_id} name mismatch: expected "${match.name}", got "${s.name}"`
        ),
        { code: "batch3_unexpected_ship_name" }
      );
    }
  }

  return true;
}

/**
 * Assert a promote plan only touches Disney logo_url + configured ship heroes.
 */
export function assertBatch3PromotePlan(plan, approved) {
  if (!plan?.updates?.length) {
    throw Object.assign(new Error("REFUSED: empty Batch 3 promote plan"), {
      code: "batch3_promote_empty"
    });
  }
  if (String(plan.line_id) !== DISNEY_CRUISE_LINE_ID) {
    throw Object.assign(new Error("REFUSED: Batch 3 promote line_id must be Disney"), {
      code: "batch3_promote_foreign_line"
    });
  }
  if (plan.updates.length !== 8 || plan.updates.length !== approved.expected_total) {
    throw Object.assign(
      new Error(
        `REFUSED: Batch 3 promote field count mismatch: expected 8, got ${plan.updates.length}`
      ),
      { code: "batch3_promote_count_mismatch" }
    );
  }
  const approvedShipIds = new Set(approved.ships.map((s) => String(s.id)));
  for (const u of plan.updates) {
    if (u.table === "ci_cruise_lines" && u.field === "logo_url") {
      if (String(u.entity_uuid) !== DISNEY_CRUISE_LINE_ID) {
        throw Object.assign(new Error("REFUSED: Batch 3 promote logo must target Disney"), {
          code: "batch3_promote_foreign_line"
        });
      }
      continue;
    }
    if (u.table === "ci_cruise_ships" && u.field === "hero_image_url") {
      if (!approvedShipIds.has(String(u.entity_uuid))) {
        throw Object.assign(
          new Error(`REFUSED: Batch 3 promote ship ${u.entity_uuid} not approved`),
          { code: "batch3_promote_ship_not_approved" }
        );
      }
      continue;
    }
    throw Object.assign(new Error(`REFUSED: Batch 3 cannot update ${u.table}.${u.field}`), {
      code: "batch3_promote_field_forbidden"
    });
  }
  return true;
}
