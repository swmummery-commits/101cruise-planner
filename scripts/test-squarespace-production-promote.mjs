/**
 * Offline tests for gated Original-project PROMOTE (Princess only).
 * No network. No credentials printed. No live DB writes.
 */

import {
  DEV_REF,
  PRODUCTION_REF,
  resolveMigrationTarget
} from "./lib/squarespace-ci-media/target.js";
import {
  PRODUCTION_COPY_ALLOWED_LINE_ID,
  PRODUCTION_COPY_CONFIRM_TOKEN,
  assertProductionCopyCliGate
} from "./lib/squarespace-ci-media/production-copy-gate.js";
import {
  PRODUCTION_PROMOTE_ALLOWED_LINE_ID,
  PRODUCTION_PROMOTE_CONFIRM_TOKEN,
  PRODUCTION_PROMOTE_ALLOWED_SHIP_NAME,
  parseConfirmProductionPromote,
  assertProductionPromoteCliGate,
  buildProductionPromotePlan,
  assertProductionPromotePublicUrls,
  buildProductionPromoteManifest,
  applyVerifiedSequentialProductionPromote
} from "./lib/squarespace-ci-media/production-promote-gate.js";

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

const LINE_ID = PRODUCTION_PROMOTE_ALLOWED_LINE_ID;
const SHIP_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SQ_LOGO = "https://images.squarespace-cdn.com/content/princess-logo.png";
const SQ_HERO = "https://images.squarespace-cdn.com/content/crown-princess-hero.jpg";
const SB_LOGO = "https://xikbibxyinttllxamgao.supabase.co/storage/v1/object/public/cruise-media/lines/logo.png";
const SB_HERO = "https://xikbibxyinttllxamgao.supabase.co/storage/v1/object/public/cruise-media/ships/hero.jpg";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function fixtureLine(overrides = {}) {
  return {
    id: LINE_ID,
    name: "Princess Cruises",
    logo_url: SQ_LOGO,
    ...overrides
  };
}

function fixtureShip(overrides = {}) {
  return {
    id: SHIP_ID,
    name: PRODUCTION_PROMOTE_ALLOWED_SHIP_NAME,
    cruise_line_id: LINE_ID,
    hero_image_url: SQ_HERO,
    ...overrides
  };
}

function fixtureMedia() {
  return [
    {
      id: "ml-logo",
      media_type: "cruise_line",
      cruise_line_id: LINE_ID,
      ship_id: null,
      public_url: SB_LOGO,
      storage_path: `lines/${LINE_ID}/${HASH_A.slice(0, 12)}-logo.png`,
      content_hash: HASH_A,
      import_source: "squarespace_ci_migration",
      source_url: SQ_LOGO
    },
    {
      id: "ml-hero",
      media_type: "ship",
      cruise_line_id: LINE_ID,
      ship_id: SHIP_ID,
      public_url: SB_HERO,
      storage_path: `ships/${SHIP_ID}/${HASH_B.slice(0, 12)}-hero.jpg`,
      content_hash: HASH_B,
      import_source: "squarespace_ci_migration",
      source_url: SQ_HERO
    }
  ];
}

async function main() {
  let passed = 0;
  const mixedEnv = {
    SUPABASE_DEV_URL: `https://${DEV_REF}.supabase.co`,
    SUPABASE_DEV_SERVICE_ROLE_KEY: "dev-secret-value-not-printed",
    SUPABASE_URL: `https://${PRODUCTION_REF}.supabase.co`,
    SUPABASE_SERVICE_ROLE_KEY: "prod-secret-value-not-printed"
  };

  // production promote resolves as gated (not open writes)
  const prodPromote = resolveMigrationTarget({
    target: "production",
    mode: "promote",
    env: mixedEnv
  });
  assert(prodPromote.production_promote_gated === true, "prod promote gated");
  assert(prodPromote.writes_allowed === false, "writes not open");
  assert(prodPromote.project_ref === PRODUCTION_REF, "prod ref");
  passed += 1;

  // production rollback still blocked
  assertThrows(
    () => resolveMigrationTarget({ target: "production", mode: "rollback", env: mixedEnv }),
    "production_write_forbidden"
  );
  passed += 1;

  // DEV promote unchanged
  const devPromote = resolveMigrationTarget({ target: "dev", mode: "promote", env: mixedEnv });
  assert(devPromote.writes_allowed === true, "dev promote writes");
  assert(devPromote.production_promote_gated === false, "dev not gated promote");
  passed += 1;

  // Original-project copy safeguard remains intact
  assert(
    assertProductionCopyCliGate({
      target: "production",
      mode: "copy",
      projectRef: PRODUCTION_REF,
      expectedProductionRef: PRODUCTION_REF,
      scope: { lineId: PRODUCTION_COPY_ALLOWED_LINE_ID, shipId: null, entityIds: null },
      confirmToken: PRODUCTION_COPY_CONFIRM_TOKEN
    }) === true,
    "copy gate intact"
  );
  passed += 1;

  const goodScope = { lineId: LINE_ID, shipId: null, entityIds: null };

  assert(
    parseConfirmProductionPromote([`--confirm-production-promote=${PRODUCTION_PROMOTE_CONFIRM_TOKEN}`]) ===
      PRODUCTION_PROMOTE_CONFIRM_TOKEN,
    "confirm parse"
  );
  passed += 1;

  // missing confirmation aborts
  assertThrows(
    () =>
      assertProductionPromoteCliGate({
        target: "production",
        mode: "promote",
        projectRef: PRODUCTION_REF,
        expectedProductionRef: PRODUCTION_REF,
        scope: goodScope,
        confirmToken: null
      }),
    "production_promote_confirm_invalid"
  );
  passed += 1;

  // wrong confirmation aborts
  assertThrows(
    () =>
      assertProductionPromoteCliGate({
        target: "production",
        mode: "promote",
        projectRef: PRODUCTION_REF,
        expectedProductionRef: PRODUCTION_REF,
        scope: goodScope,
        confirmToken: "WRONG"
      }),
    "production_promote_confirm_invalid"
  );
  passed += 1;

  // wrong line UUID aborts
  assertThrows(
    () =>
      assertProductionPromoteCliGate({
        target: "production",
        mode: "promote",
        projectRef: PRODUCTION_REF,
        expectedProductionRef: PRODUCTION_REF,
        scope: { lineId: "00000000-0000-0000-0000-000000000000", shipId: null, entityIds: null },
        confirmToken: PRODUCTION_PROMOTE_CONFIRM_TOKEN
      }),
    "production_promote_line_not_allowed"
  );
  passed += 1;

  // broad scope aborts
  assertThrows(
    () =>
      assertProductionPromoteCliGate({
        target: "production",
        mode: "promote",
        projectRef: PRODUCTION_REF,
        expectedProductionRef: PRODUCTION_REF,
        scope: { lineId: LINE_ID, shipId: SHIP_ID, entityIds: null },
        confirmToken: PRODUCTION_PROMOTE_CONFIRM_TOKEN
      }),
    "production_promote_scope_invalid"
  );
  passed += 1;

  assertThrows(
    () =>
      assertProductionPromoteCliGate({
        target: "production",
        mode: "promote",
        projectRef: PRODUCTION_REF,
        expectedProductionRef: PRODUCTION_REF,
        scope: { lineId: LINE_ID, shipId: null, entityIds: ["a", "b"] },
        confirmToken: PRODUCTION_PROMOTE_CONFIRM_TOKEN
      }),
    "production_promote_scope_invalid"
  );
  passed += 1;

  assert(
    assertProductionPromoteCliGate({
      target: "production",
      mode: "promote",
      projectRef: PRODUCTION_REF,
      expectedProductionRef: PRODUCTION_REF,
      scope: goodScope,
      confirmToken: PRODUCTION_PROMOTE_CONFIRM_TOKEN
    }) === true,
    "cli gate ok"
  );
  passed += 1;

  // happy plan
  const plan = buildProductionPromotePlan({
    line: fixtureLine(),
    ships: [fixtureShip()],
    mediaRows: fixtureMedia()
  });
  assert(plan.candidate_count === 2, "exactly 2");
  assert(plan.uploads === 0 && plan.media_library_inserts === 0, "no upload/insert");
  assert(
    plan.updates.every(
      (u) =>
        (u.table === "ci_cruise_lines" && u.field === "logo_url") ||
        (u.table === "ci_cruise_ships" && u.field === "hero_image_url")
    ),
    "only two approved fields"
  );
  passed += 1;

  // missing Media Library record aborts
  assertThrows(
    () =>
      buildProductionPromotePlan({
        line: fixtureLine(),
        ships: [fixtureShip()],
        mediaRows: [fixtureMedia()[0]]
      }),
    "production_promote_media_count"
  );
  passed += 1;

  // incorrect entity relationship aborts (hero on wrong ship)
  const badRel = fixtureMedia();
  badRel[1].ship_id = "ffffffff-ffff-ffff-ffff-ffffffffffff";
  assertThrows(
    () =>
      buildProductionPromotePlan({
        line: fixtureLine(),
        ships: [fixtureShip()],
        mediaRows: badRel
      }),
    "production_promote_missing_hero_media"
  );
  passed += 1;

  // source URL mismatch aborts
  assertThrows(
    () =>
      buildProductionPromotePlan({
        line: fixtureLine({ logo_url: "https://images.squarespace-cdn.com/other.png" }),
        ships: [fixtureShip()],
        mediaRows: fixtureMedia()
      }),
    "production_promote_source_mismatch"
  );
  passed += 1;

  // unreachable Supabase public URL aborts
  await assertThrowsAsync(
    () => assertProductionPromotePublicUrls(plan, async () => false),
    "production_promote_public_url_unreachable"
  );
  passed += 1;

  await assertProductionPromotePublicUrls(plan, async () => true);
  passed += 1;

  // rollback manifest is created with guarded restore command
  const manifest = buildProductionPromoteManifest(plan, {
    projectRef: PRODUCTION_REF,
    timestamp: "2026-07-18T00:00:00.000Z"
  });
  assert(manifest.entries.length === 2, "manifest entries");
  assert(manifest.entries[0].original_url === SQ_LOGO, "original squarespace");
  assert(manifest.entries[0].new_url === SB_LOGO, "new supabase");
  assert(manifest.entries[0].media_library_id, "ml id");
  assert(manifest.entries[0].content_hash, "hash");
  assert(manifest.entries[0].migrated_timestamp, "timestamp");
  assert(
    String(manifest.guarded_restore_command).includes("--confirm-production-rollback=PRINCESS"),
    "guarded restore"
  );
  assert(
    String(manifest.note || "").toLowerCase().includes("not enabled"),
    "broad rollback not enabled"
  );
  passed += 1;

  // verified sequential success
  const writes = [];
  const ok = await applyVerifiedSequentialProductionPromote(plan, {
    verifiedWrite: async (p) => {
      writes.push({ ...p });
      return {
        http_status: 200,
        affected_row_count: 1,
        returned_entity_uuid: p.id,
        returned_field_value: p.value,
        post_write_verification: "ok",
        persisted_value: p.value
      };
    }
  });
  assert(ok.ok === true && writes.length === 2, "two verified writes");
  assert(writes[0].field === "logo_url" && writes[1].field === "hero_image_url", "fields");
  assert(ok.strategy === "verified_sequential_update_with_compensating_rollback", "strategy");
  passed += 1;

  // partial failure does not leave a partial promotion (compensating rollback)
  const state = {
    [LINE_ID]: { logo_url: SQ_LOGO },
    [SHIP_ID]: { hero_image_url: SQ_HERO }
  };
  let calls = 0;
  await assertThrowsAsync(
    () =>
      applyVerifiedSequentialProductionPromote(plan, {
        verifiedWrite: async ({ id, field, value }) => {
          calls += 1;
          if (calls === 2) throw Object.assign(new Error("second patch failed"), { code: "patch_http_error" });
          state[id][field] = value;
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
  assert(state[LINE_ID].logo_url === SQ_LOGO, "logo restored");
  assert(state[SHIP_ID].hero_image_url === SQ_HERO, "hero untouched/restored");
  passed += 1;

  console.log(`PASS ${passed} squarespace production-promote-gate tests`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
