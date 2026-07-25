/**
 * Approved Batch 2 — mixed logo + ship-hero cruise lines (Original-project).
 * Disney Cruise Line is intentionally excluded (reserved for Batch 3).
 *
 * Source of truth for UUIDs/names/counts: dry-run report
 * tmp/squarespace-migration/dry-run-1784950810217.json
 * (canonical name for Atlas is "Atlas Cruises").
 */

import {
  DISNEY_CRUISE_LINE_ID,
  DISNEY_CRUISE_LINE_NAME
} from "./batch-3-disney.js";

export { DISNEY_CRUISE_LINE_ID, DISNEY_CRUISE_LINE_NAME };

export const BATCH_2_ID = "batch-2-mixed-lines";
export const BATCH_2_CONFIRM_TOKEN = "BATCH-2-MIXED";

export const BATCH_2_ADMIN_WARNING =
  "Close all open Cruise Database cruise-line and ship edit forms in 101cruise Admin. Reopen or hard-refresh the Admin after the batch completes.";

/**
 * Exact approved order. Names/UUIDs/counts/ships from Original dry-run inventory.
 */
export const BATCH_2_LINES = Object.freeze([
  Object.freeze({
    order: 1,
    name: "Celebrity Cruises",
    id: "aa2c50ed-7ff5-472d-bc96-3d686d76c5ec",
    expected_logo_count: 1,
    expected_ship_hero_count: 2,
    expected_total: 3,
    ships: Object.freeze([
      Object.freeze({
        id: "62916813-6cee-4c5f-88ec-e7052d396e68",
        name: "Celebrity Edge"
      }),
      Object.freeze({
        id: "9d1a3655-be39-405c-9e00-96d7bb4925c7",
        name: "Celebrity Millennium"
      })
    ])
  }),
  Object.freeze({
    order: 2,
    name: "Atlas Cruises",
    id: "8aa1d0a8-c04c-4494-8ff3-928e811057e1",
    expected_logo_count: 1,
    expected_ship_hero_count: 3,
    expected_total: 4,
    note: "Canonical CI name is Atlas Cruises (sometimes marketed as Atlas Ocean Voyages).",
    ships: Object.freeze([
      Object.freeze({
        id: "786f27fa-5feb-4a60-8a53-ee5ebcde9b7e",
        name: "World Adventurer"
      }),
      Object.freeze({
        id: "17613da6-0ebe-4949-ba5f-8f5d34393d16",
        name: "World Navigator"
      }),
      Object.freeze({
        id: "0bfda65d-53c4-4edc-990c-0dd92262996f",
        name: "World Traveller"
      })
    ])
  }),
  Object.freeze({
    order: 3,
    name: "Azamara",
    id: "245e6de9-9ec2-480b-ab72-ed8943fe4f22",
    expected_logo_count: 1,
    expected_ship_hero_count: 3,
    expected_total: 4,
    ships: Object.freeze([
      Object.freeze({
        id: "c6e544ad-3282-4c40-8a4c-5c663ec08dec",
        name: "Journey"
      }),
      Object.freeze({
        id: "da80796b-db58-49a6-b763-502970b61d30",
        name: "Pursuit"
      }),
      Object.freeze({
        id: "9b086346-2c6e-4490-af21-53ae98b6129d",
        name: "Quest"
      })
    ])
  }),
  Object.freeze({
    order: 4,
    name: "Explora Journeys",
    id: "8b28c83e-2bf0-44ce-9795-ec3051c34050",
    expected_logo_count: 1,
    expected_ship_hero_count: 3,
    expected_total: 4,
    ships: Object.freeze([
      Object.freeze({
        id: "1d394781-1763-432a-8e87-a49845b0db9d",
        name: "EXPLORA I"
      }),
      Object.freeze({
        id: "6220facb-9836-4bfa-9cb4-c176fa1f795a",
        name: "EXPLORA II"
      }),
      Object.freeze({
        id: "9f60042d-64bd-4e8b-b420-816f2e7c8672",
        name: "EXPLORA III"
      })
    ])
  }),
  Object.freeze({
    order: 5,
    name: "Oceania Cruises",
    id: "05c15b0e-dc11-4963-af43-1bc80dd266f7",
    expected_logo_count: 1,
    expected_ship_hero_count: 1,
    expected_total: 2,
    ships: Object.freeze([
      Object.freeze({
        id: "a63c37c2-6302-4680-b434-995a98c9e863",
        name: "Allura"
      })
    ])
  }),
  Object.freeze({
    order: 6,
    name: "Royal Caribbean International",
    id: "1cea3c83-5fd5-41d0-b5f7-4026fee00ab5",
    expected_logo_count: 1,
    expected_ship_hero_count: 1,
    expected_total: 2,
    ships: Object.freeze([
      Object.freeze({
        id: "193071d7-46ee-438f-9025-ff9551ce4aa2",
        name: "Icon of the Seas"
      })
    ])
  })
]);

export const BATCH_2_LINE_IDS = Object.freeze(BATCH_2_LINES.map((l) => l.id));
export const BATCH_2_SHIP_IDS = Object.freeze(
  BATCH_2_LINES.flatMap((l) => l.ships.map((s) => s.id))
);

export function getBatch2Config() {
  return {
    id: BATCH_2_ID,
    confirm_token: BATCH_2_CONFIRM_TOKEN,
    kind: "mixed",
    lines: BATCH_2_LINES,
    admin_warning: BATCH_2_ADMIN_WARNING,
    excludes_disney: true,
    disney_line_id: DISNEY_CRUISE_LINE_ID,
    expected_total_assets: BATCH_2_LINES.reduce((n, l) => n + l.expected_total, 0)
  };
}

/**
 * Validate Batch 2 per-line Squarespace scope against fixed configuration.
 *
 * @param {{
 *   approved: object,
 *   logoCandidates: Array<{url?: string}>,
 *   shipHeroCandidates: Array<{ship_id: string, name: string, url?: string}>
 * }} opts
 */
export function assertBatch2MixedScope({ approved, logoCandidates, shipHeroCandidates }) {
  const logos = logoCandidates || [];
  const ships = shipHeroCandidates || [];

  if (String(approved.id) === DISNEY_CRUISE_LINE_ID || approved.name === DISNEY_CRUISE_LINE_NAME) {
    throw Object.assign(new Error("REFUSED: Disney Cruise Line is excluded from Batch 2"), {
      code: "batch2_disney_forbidden"
    });
  }

  if (logos.length !== approved.expected_logo_count) {
    throw Object.assign(
      new Error(
        `REFUSED: ${approved.name} unexpected logo count: expected ${approved.expected_logo_count}, got ${logos.length}`
      ),
      { code: "batch2_unexpected_logo_count" }
    );
  }
  if (ships.length !== approved.expected_ship_hero_count) {
    throw Object.assign(
      new Error(
        `REFUSED: ${approved.name} unexpected ship-hero count: expected ${approved.expected_ship_hero_count}, got ${ships.length}`
      ),
      { code: "batch2_unexpected_ship_count" }
    );
  }
  const total = logos.length + ships.length;
  if (total !== approved.expected_total) {
    throw Object.assign(
      new Error(
        `REFUSED: ${approved.name} unexpected total candidates: expected ${approved.expected_total}, got ${total}`
      ),
      { code: "batch2_unexpected_total_count" }
    );
  }

  const expectedNames = new Set(approved.ships.map((s) => s.name));
  const expectedIds = new Set(approved.ships.map((s) => String(s.id)));
  const actualNames = new Set(ships.map((s) => s.name));
  const actualIds = new Set(ships.map((s) => String(s.ship_id)));

  for (const name of expectedNames) {
    if (!actualNames.has(name)) {
      throw Object.assign(
        new Error(`REFUSED: ${approved.name} missing expected ship "${name}"`),
        { code: "batch2_missing_ship" }
      );
    }
  }
  for (const name of actualNames) {
    if (!expectedNames.has(name)) {
      throw Object.assign(
        new Error(`REFUSED: ${approved.name} unexpected ship name "${name}"`),
        { code: "batch2_unexpected_ship_name" }
      );
    }
  }
  for (const id of expectedIds) {
    if (!actualIds.has(id)) {
      throw Object.assign(
        new Error(`REFUSED: ${approved.name} missing expected ship UUID ${id}`),
        { code: "batch2_missing_ship" }
      );
    }
  }
  for (const id of actualIds) {
    if (!expectedIds.has(id)) {
      throw Object.assign(
        new Error(`REFUSED: ${approved.name} unexpected ship UUID ${id}`),
        { code: "batch2_unexpected_ship_id" }
      );
    }
  }

  // Ownership: each candidate ship must map to an approved ship under this line.
  for (const s of ships) {
    const match = approved.ships.find((a) => String(a.id) === String(s.ship_id));
    if (!match) {
      throw Object.assign(
        new Error(`REFUSED: ship ${s.ship_id} is not approved for ${approved.name}`),
        { code: "batch2_ship_not_approved" }
      );
    }
    if (match.name !== s.name) {
      throw Object.assign(
        new Error(
          `REFUSED: ship UUID ${s.ship_id} name mismatch: expected "${match.name}", got "${s.name}"`
        ),
        { code: "batch2_unexpected_ship_name" }
      );
    }
  }

  return true;
}

/**
 * Assert a promote plan only touches Batch 2 approved line/ship fields.
 */
export function assertBatch2PromotePlan(plan, approved) {
  if (!plan?.updates?.length) {
    throw Object.assign(new Error("REFUSED: empty Batch 2 promote plan"), {
      code: "batch2_promote_empty"
    });
  }
  if (plan.updates.length !== approved.expected_total) {
    throw Object.assign(
      new Error(
        `REFUSED: Batch 2 promote field count mismatch for ${approved.name}: expected ${approved.expected_total}, got ${plan.updates.length}`
      ),
      { code: "batch2_promote_count_mismatch" }
    );
  }
  const approvedShipIds = new Set(approved.ships.map((s) => String(s.id)));
  for (const u of plan.updates) {
    if (u.table === "ci_cruise_lines" && u.field === "logo_url") {
      if (String(u.entity_uuid) !== String(approved.id)) {
        throw Object.assign(new Error("REFUSED: Batch 2 promote logo targets wrong line"), {
          code: "batch2_promote_foreign_line"
        });
      }
      continue;
    }
    if (u.table === "ci_cruise_ships" && u.field === "hero_image_url") {
      if (!approvedShipIds.has(String(u.entity_uuid))) {
        throw Object.assign(
          new Error(`REFUSED: Batch 2 promote ship ${u.entity_uuid} not approved`),
          { code: "batch2_promote_ship_not_approved" }
        );
      }
      continue;
    }
    throw Object.assign(new Error(`REFUSED: Batch 2 cannot update ${u.table}.${u.field}`), {
      code: "batch2_promote_field_forbidden"
    });
  }
  if (String(plan.line_id) === DISNEY_CRUISE_LINE_ID) {
    throw Object.assign(new Error("REFUSED: Disney excluded from Batch 2 promote"), {
      code: "batch2_disney_forbidden"
    });
  }
  return true;
}
