/**
 * Offline tests for verified CI PATCH + Princess logo-only repair gate.
 * No network. No credentials printed. No live DB writes.
 */

import {
  assertExactOnePatchedRow,
  verifiedCiFieldWrite,
  applyVerifiedSequentialUpdates
} from "./lib/squarespace-ci-media/verified-ci-patch.js";
import {
  PRODUCTION_PROMOTE_ALLOWED_LINE_ID,
  applyVerifiedSequentialProductionPromote
} from "./lib/squarespace-ci-media/production-promote-gate.js";
import {
  PRODUCTION_LOGO_REPAIR_ALLOWED_LINE_ID,
  PRODUCTION_LOGO_REPAIR_CONFIRM_TOKEN,
  PRODUCTION_LOGO_REPAIR_CROWN_SHIP_ID,
  ADMIN_STALE_FORM_WARNING,
  parseConfirmProductionLogoRepair,
  assertProductionLogoRepairCliGate,
  buildProductionLogoRepairPlan,
  buildProductionLogoRepairManifest
} from "./lib/squarespace-ci-media/production-logo-repair-gate.js";
import { PRODUCTION_REF } from "./lib/squarespace-ci-media/target.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertThrows(fn, code) {
  let ok = false;
  try {
    fn();
  } catch (e) {
    ok = e.code === code;
    if (!ok) throw new Error(`expected code ${code}, got ${e.code}: ${e.message}`);
  }
  assert(ok, `expected throw ${code}`);
}

async function assertThrowsAsync(fn, code) {
  let ok = false;
  try {
    await fn();
  } catch (e) {
    ok = e.code === code;
    if (!ok) throw new Error(`expected code ${code}, got ${e.code}: ${e.message}`);
  }
  assert(ok, `expected throw ${code}`);
}

const LINE_ID = PRODUCTION_LOGO_REPAIR_ALLOWED_LINE_ID;
const SQ_LOGO =
  "https://images.squarespace-cdn.com/content/6603b29b5ae2121e71e653f4/44dd1151-1ccb-46aa-811d-7ac2cd2de076/Princess.png?content-type=image%2Fpng";
const SB_LOGO = `https://${PRODUCTION_REF}.supabase.co/storage/v1/object/public/cruise-media/lines/${LINE_ID}/c32b7d8d2bbd-Princess.png`;
const HASH = "c32b7d8d2bbd9a05f2077e0ca2ad3c73867ace6d8795b1ea2a7a98d5df2826ec";

function fixtureLine(overrides = {}) {
  return { id: LINE_ID, name: "Princess Cruises", logo_url: SQ_LOGO, ...overrides };
}

function fixtureLogoMedia(overrides = {}) {
  return {
    id: "53b467fd-47dd-4338-bff9-3ecab6608995",
    media_type: "cruise_line",
    cruise_line_id: LINE_ID,
    ship_id: null,
    public_url: SB_LOGO,
    storage_path: `lines/${LINE_ID}/c32b7d8d2bbd-Princess.png`,
    content_hash: HASH,
    import_source: "squarespace_ci_migration",
    source_url: SQ_LOGO,
    ...overrides
  };
}

async function main() {
  let passed = 0;

  // PATCH returns [] → failure
  assertThrows(
    () =>
      assertExactOnePatchedRow([], {
        entityUuid: LINE_ID,
        field: "logo_url",
        expectedValue: SB_LOGO
      }),
    "patch_zero_rows"
  );
  passed += 1;

  // PATCH returns multiple rows → failure
  assertThrows(
    () =>
      assertExactOnePatchedRow(
        [
          { id: LINE_ID, logo_url: SB_LOGO },
          { id: LINE_ID, logo_url: SB_LOGO }
        ],
        { entityUuid: LINE_ID, field: "logo_url", expectedValue: SB_LOGO }
      ),
    "patch_multiple_rows"
  );
  passed += 1;

  // wrong UUID returned → failure
  assertThrows(
    () =>
      assertExactOnePatchedRow([{ id: "00000000-0000-0000-0000-000000000000", logo_url: SB_LOGO }], {
        entityUuid: LINE_ID,
        field: "logo_url",
        expectedValue: SB_LOGO
      }),
    "patch_wrong_uuid"
  );
  passed += 1;

  // wrong field value returned → failure
  assertThrows(
    () =>
      assertExactOnePatchedRow([{ id: LINE_ID, logo_url: SQ_LOGO }], {
        entityUuid: LINE_ID,
        field: "logo_url",
        expectedValue: SB_LOGO
      }),
    "patch_wrong_field_value"
  );
  passed += 1;

  // successful PATCH followed by successful re-read
  const okWrite = await verifiedCiFieldWrite({
    table: "ci_cruise_lines",
    id: LINE_ID,
    field: "logo_url",
    value: SB_LOGO,
    patchRow: async () => ({
      status: 200,
      body: [{ id: LINE_ID, logo_url: SB_LOGO }]
    }),
    readRow: async () => ({ id: LINE_ID, logo_url: SB_LOGO })
  });
  assert(okWrite.post_write_verification === "ok", "post write ok");
  assert(okWrite.affected_row_count === 1, "count 1");
  assert(okWrite.http_status === 200, "status 200");
  assert(okWrite.returned_entity_uuid === LINE_ID, "uuid");
  assert(okWrite.returned_field_value === SB_LOGO, "value");
  passed += 1;

  // post-write re-read mismatch → failure and compensating rollback
  const state = {
    logo: SQ_LOGO,
    hero: "https://images.squarespace-cdn.com/hero.jpg"
  };
  const shipId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const sbHero = `https://${PRODUCTION_REF}.supabase.co/storage/v1/object/public/cruise-media/ships/h.jpg`;
  const updates = [
    {
      table: "ci_cruise_lines",
      entity_uuid: LINE_ID,
      field: "logo_url",
      original_url: SQ_LOGO,
      new_url: SB_LOGO
    },
    {
      table: "ci_cruise_ships",
      entity_uuid: shipId,
      field: "hero_image_url",
      original_url: state.hero,
      new_url: sbHero
    }
  ];
  let writeCalls = 0;
  await assertThrowsAsync(
    () =>
      applyVerifiedSequentialUpdates(updates, {
        verifiedWrite: async ({ id, field, value }) => {
          writeCalls += 1;
          // first write (logo) succeeds; second write's re-read mismatches
          if (writeCalls === 1) {
            state.logo = value;
            return {
              http_status: 200,
              affected_row_count: 1,
              returned_entity_uuid: id,
              returned_field_value: value,
              post_write_verification: "ok",
              persisted_value: value
            };
          }
          if (writeCalls === 2) {
            // pretend PATCH representation looked OK but re-read fails via throwing
            throw Object.assign(new Error("re-read mismatch"), {
              code: "post_write_mismatch"
            });
          }
          // compensating rollback of logo
          state.logo = value;
          return {
            http_status: 200,
            affected_row_count: 1,
            returned_entity_uuid: id,
            returned_field_value: value,
            post_write_verification: "ok",
            persisted_value: value
          };
        }
      }),
    "production_promote_rolled_back"
  );
  assert(state.logo === SQ_LOGO, "logo rolled back");
  assert(writeCalls === 3, "write + fail + rollback");
  passed += 1;

  // rollback affects zero rows → reported failure
  await assertThrowsAsync(
    () =>
      applyVerifiedSequentialUpdates(
        [
          {
            table: "ci_cruise_lines",
            entity_uuid: LINE_ID,
            field: "logo_url",
            original_url: SQ_LOGO,
            new_url: SB_LOGO
          },
          {
            table: "ci_cruise_ships",
            entity_uuid: shipId,
            field: "hero_image_url",
            original_url: "x",
            new_url: sbHero
          }
        ],
        {
          verifiedWrite: async ({ field, value }) => {
            if (field === "logo_url" && value === SB_LOGO) {
              return {
                http_status: 200,
                affected_row_count: 1,
                returned_entity_uuid: LINE_ID,
                returned_field_value: SB_LOGO,
                post_write_verification: "ok",
                persisted_value: SB_LOGO
              };
            }
            if (field === "hero_image_url") {
              throw Object.assign(new Error("hero failed"), { code: "patch_http_error" });
            }
            // rollback of logo returns zero rows
            throw Object.assign(new Error("PATCH matched zero rows"), { code: "patch_zero_rows" });
          }
        }
      ),
    "compensating_rollback_failed"
  );
  passed += 1;

  // successful verified sequential promote shape
  const promotePlan = {
    updates: [
      {
        table: "ci_cruise_lines",
        entity_uuid: LINE_ID,
        field: "logo_url",
        original_url: SQ_LOGO,
        new_url: SB_LOGO
      }
    ]
  };
  const promoteOk = await applyVerifiedSequentialProductionPromote(promotePlan, {
    verifiedWrite: async ({ id, field, value }) => ({
      http_status: 200,
      affected_row_count: 1,
      returned_entity_uuid: id,
      returned_field_value: value,
      post_write_verification: "ok",
      persisted_value: value
    })
  });
  assert(promoteOk.strategy === "verified_sequential_update_with_compensating_rollback", "strategy");
  assert(promoteOk.applied[0].verification.affected_row_count === 1, "verified");
  passed += 1;

  // --- logo repair gate ---
  const goodScope = { lineId: LINE_ID, shipId: null, entityIds: null };
  assert(
    parseConfirmProductionLogoRepair([
      `--confirm-production-logo-repair=${PRODUCTION_LOGO_REPAIR_CONFIRM_TOKEN}`
    ]) === PRODUCTION_LOGO_REPAIR_CONFIRM_TOKEN,
    "confirm parse"
  );
  passed += 1;

  assertThrows(
    () =>
      assertProductionLogoRepairCliGate({
        target: "production",
        mode: "repair-logo",
        projectRef: PRODUCTION_REF,
        expectedProductionRef: PRODUCTION_REF,
        scope: goodScope,
        confirmToken: null
      }),
    "production_logo_repair_confirm_invalid"
  );
  passed += 1;

  assertThrows(
    () =>
      assertProductionLogoRepairCliGate({
        target: "production",
        mode: "repair-logo",
        projectRef: PRODUCTION_REF,
        expectedProductionRef: PRODUCTION_REF,
        scope: goodScope,
        confirmToken: "WRONG"
      }),
    "production_logo_repair_confirm_invalid"
  );
  passed += 1;

  const repairPlan = buildProductionLogoRepairPlan({
    line: fixtureLine(),
    mediaRows: [fixtureLogoMedia()]
  });
  assert(repairPlan.updates.length === 1, "one update");
  assert(repairPlan.updates[0].field === "logo_url", "logo only");
  assert(repairPlan.updates[0].table === "ci_cruise_lines", "line table");
  assert(repairPlan.ships_updated === 0, "no ships");
  assert(repairPlan.uploads === 0 && repairPlan.media_library_inserts === 0, "no upload/insert");
  assert(String(repairPlan.updates[0].entity_uuid) !== PRODUCTION_LOGO_REPAIR_CROWN_SHIP_ID, "not crown");
  assert(repairPlan.admin_stale_form_warning === ADMIN_STALE_FORM_WARNING, "warning");
  passed += 1;

  // repair cannot update Crown Princess (plan never includes ship fields)
  assert(
    !repairPlan.updates.some(
      (u) => u.table === "ci_cruise_ships" || u.entity_uuid === PRODUCTION_LOGO_REPAIR_CROWN_SHIP_ID
    ),
    "no crown update"
  );
  passed += 1;

  // current canonical URL not matching source_url aborts
  assertThrows(
    () =>
      buildProductionLogoRepairPlan({
        line: fixtureLine({ logo_url: "https://images.squarespace-cdn.com/other.png" }),
        mediaRows: [fixtureLogoMedia()]
      }),
    "production_logo_repair_source_mismatch"
  );
  passed += 1;

  const repairManifest = buildProductionLogoRepairManifest(repairPlan, {
    projectRef: PRODUCTION_REF,
    timestamp: "2026-07-25T00:00:00.000Z"
  });
  assert(repairManifest.entries.length === 1, "one-field manifest");
  assert(repairManifest.entries[0].field_changed === "logo_url", "manifest field");
  assert(repairManifest.admin_stale_form_warning, "manifest warning");
  passed += 1;

  assert(PRODUCTION_PROMOTE_ALLOWED_LINE_ID === PRODUCTION_LOGO_REPAIR_ALLOWED_LINE_ID, "same line");
  passed += 1;

  console.log(`PASS ${passed} verified-ci-patch + logo-repair tests`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
