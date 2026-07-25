/**
 * Offline tests for gated Original-project single-line PROMOTE (UUID confirmation).
 * No network. No credentials printed. No live DB writes.
 */

import {
  DEV_REF,
  PRODUCTION_REF,
  resolveMigrationTarget
} from "./lib/squarespace-ci-media/target.js";
import {
  PRODUCTION_COPY_ALLOWED_LINE_ID,
  assertProductionCopyCliGate,
  assertProductionCopyPlan,
  assertCopyDidNotChangeCiUrls
} from "./lib/squarespace-ci-media/production-copy-gate.js";
import {
  PRODUCTION_PROMOTE_ALLOWED_LINE_ID,
  PRODUCTION_PROMOTE_ALLOWED_SHIP_NAME,
  PRODUCTION_PROMOTE_ADMIN_WARNING,
  parseConfirmProductionPromote,
  assertProductionPromoteCliGate,
  buildProductionPromotePlan,
  assertProductionPromotePublicUrls,
  buildProductionPromoteManifest,
  applyVerifiedSequentialProductionPromote,
  formatProductionPromoteBanner
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

const PRINCESS_ID = PRODUCTION_PROMOTE_ALLOWED_LINE_ID;
const NCL_ID = "c5f5361f-ebe5-4ff4-babe-7eb07f609bae";
const SHIP_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SHIP_B = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER_LINE = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const SQ_LOGO = "https://images.squarespace-cdn.com/content/logo.png";
const SQ_HERO = "https://images.squarespace-cdn.com/content/hero.jpg";
const SQ_HERO_B = "https://images.squarespace-cdn.com/content/hero-b.jpg";
const SB_LOGO = `https://${PRODUCTION_REF}.supabase.co/storage/v1/object/public/cruise-media/lines/logo.png`;
const SB_HERO = `https://${PRODUCTION_REF}.supabase.co/storage/v1/object/public/cruise-media/ships/hero.jpg`;
const SB_HERO_B = `https://${PRODUCTION_REF}.supabase.co/storage/v1/object/public/cruise-media/ships/hero-b.jpg`;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function fixtureLine(id, name, logo = SQ_LOGO) {
  return { id, name, logo_url: logo };
}

function fixtureShip(id, lineId, name, hero = SQ_HERO) {
  return { id, name, cruise_line_id: lineId, hero_image_url: hero };
}

function logoMedia(lineId, source = SQ_LOGO, publicUrl = SB_LOGO) {
  return {
    id: "ml-logo",
    media_type: "cruise_line",
    cruise_line_id: lineId,
    ship_id: null,
    public_url: publicUrl,
    storage_path: `lines/${lineId}/logo.png`,
    content_hash: HASH_A,
    import_source: "squarespace_ci_migration",
    source_url: source
  };
}

function heroMedia(lineId, shipId, source = SQ_HERO, publicUrl = SB_HERO, hash = HASH_B) {
  return {
    id: `ml-hero-${shipId}`,
    media_type: "ship",
    cruise_line_id: lineId,
    ship_id: shipId,
    public_url: publicUrl,
    storage_path: `ships/${shipId}/hero.jpg`,
    content_hash: hash,
    import_source: "squarespace_ci_migration",
    source_url: source
  };
}

async function main() {
  let passed = 0;
  const mixedEnv = {
    SUPABASE_DEV_URL: `https://${DEV_REF}.supabase.co`,
    SUPABASE_DEV_SERVICE_ROLE_KEY: "dev-secret-value-not-printed",
    SUPABASE_URL: `https://${PRODUCTION_REF}.supabase.co`,
    SUPABASE_SERVICE_ROLE_KEY: "prod-secret-value-not-printed"
  };

  // DEV promote unchanged
  const devPromote = resolveMigrationTarget({ target: "dev", mode: "promote", env: mixedEnv });
  assert(devPromote.writes_allowed === true, "dev promote writes");
  assert(devPromote.production_promote_gated === false, "dev not gated");
  passed += 1;

  // Original-project copy safeguard still works with UUID confirm
  assert(
    assertProductionCopyCliGate({
      target: "production",
      mode: "copy",
      projectRef: PRODUCTION_REF,
      expectedProductionRef: PRODUCTION_REF,
      scope: { lineId: NCL_ID, shipId: null, entityIds: null },
      confirmToken: NCL_ID,
      line: fixtureLine(NCL_ID, "Norwegian Cruise Line")
    }) === true,
    "copy uuid gate"
  );
  passed += 1;

  const goodScope = { lineId: NCL_ID, shipId: null, entityIds: null };
  assert(parseConfirmProductionPromote([`--confirm-production-promote=${NCL_ID}`]) === NCL_ID, "parse");
  passed += 1;

  // UUID confirmation must exactly match line ID / wrong UUID aborts
  assertThrows(
    () =>
      assertProductionPromoteCliGate({
        target: "production",
        mode: "promote",
        projectRef: PRODUCTION_REF,
        expectedProductionRef: PRODUCTION_REF,
        scope: goodScope,
        confirmToken: null,
        line: fixtureLine(NCL_ID, "Norwegian Cruise Line")
      }),
    "production_promote_confirm_invalid"
  );
  passed += 1;

  assertThrows(
    () =>
      assertProductionPromoteCliGate({
        target: "production",
        mode: "promote",
        projectRef: PRODUCTION_REF,
        expectedProductionRef: PRODUCTION_REF,
        scope: goodScope,
        confirmToken: "PRINCESS",
        line: fixtureLine(NCL_ID, "Norwegian Cruise Line")
      }),
    "production_promote_confirm_invalid"
  );
  passed += 1;

  assertThrows(
    () =>
      assertProductionPromoteCliGate({
        target: "production",
        mode: "promote",
        projectRef: PRODUCTION_REF,
        expectedProductionRef: PRODUCTION_REF,
        scope: goodScope,
        confirmToken: OTHER_LINE,
        line: fixtureLine(NCL_ID, "Norwegian Cruise Line")
      }),
    "production_promote_confirm_invalid"
  );
  passed += 1;

  // missing line aborts
  assertThrows(
    () =>
      assertProductionPromoteCliGate({
        target: "production",
        mode: "promote",
        projectRef: PRODUCTION_REF,
        expectedProductionRef: PRODUCTION_REF,
        scope: goodScope,
        confirmToken: NCL_ID,
        line: null
      }),
    "production_promote_line_missing"
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
        scope: { lineId: NCL_ID, shipId: SHIP_ID, entityIds: null },
        confirmToken: NCL_ID,
        line: fixtureLine(NCL_ID, "NCL")
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
        scope: { lineId: NCL_ID, shipId: null, entityIds: ["a"] },
        confirmToken: NCL_ID,
        line: fixtureLine(NCL_ID, "NCL")
      }),
    "production_promote_scope_invalid"
  );
  passed += 1;

  // logo-only line works (Norwegian-style)
  const nclPlan = buildProductionPromotePlan({
    line: fixtureLine(NCL_ID, "Norwegian Cruise Line"),
    ships: [fixtureShip(SHIP_ID, NCL_ID, "Some Ship", null)],
    mediaRows: [logoMedia(NCL_ID)],
    lineId: NCL_ID
  });
  assert(nclPlan.candidate_count === 1, "logo only count");
  assert(nclPlan.uploads === 0 && nclPlan.media_library_inserts === 0, "no upload/insert");
  assert(nclPlan.updates.every((u) => u.field === "logo_url"), "logo field only");
  assert(nclPlan.ship_names.length === 0, "no ships");
  passed += 1;

  // mixed logo-and-ship line works
  const mixedPlan = buildProductionPromotePlan({
    line: fixtureLine(PRINCESS_ID, "Princess Cruises"),
    ships: [
      fixtureShip(SHIP_ID, PRINCESS_ID, PRODUCTION_PROMOTE_ALLOWED_SHIP_NAME, SQ_HERO),
      fixtureShip(SHIP_B, PRINCESS_ID, "Other Ship", SQ_HERO_B)
    ],
    mediaRows: [
      logoMedia(PRINCESS_ID),
      heroMedia(PRINCESS_ID, SHIP_ID),
      heroMedia(PRINCESS_ID, SHIP_B, SQ_HERO_B, SB_HERO_B, HASH_C)
    ],
    lineId: PRINCESS_ID
  });
  assert(mixedPlan.candidate_count === 3, "mixed 3");
  assert(mixedPlan.ship_names.includes(PRODUCTION_PROMOTE_ALLOWED_SHIP_NAME), "crown");
  assert(mixedPlan.admin_stale_form_warning === PRODUCTION_PROMOTE_ADMIN_WARNING, "warning");
  passed += 1;

  // Princess workflow remains supported under general UUID gate
  assert(
    assertProductionPromoteCliGate({
      target: "production",
      mode: "promote",
      projectRef: PRODUCTION_REF,
      expectedProductionRef: PRODUCTION_REF,
      scope: { lineId: PRINCESS_ID, shipId: null, entityIds: null },
      confirmToken: PRINCESS_ID,
      line: fixtureLine(PRINCESS_ID, "Princess Cruises")
    }) === true,
    "princess uuid gate"
  );
  passed += 1;

  // all ship relationships must belong to selected line / foreign media aborts
  assertThrows(
    () =>
      buildProductionPromotePlan({
        line: fixtureLine(NCL_ID, "NCL"),
        ships: [fixtureShip(SHIP_ID, NCL_ID, "Ship", SQ_HERO)],
        mediaRows: [logoMedia(NCL_ID), heroMedia(OTHER_LINE, SHIP_ID)],
        lineId: NCL_ID
      }),
    "production_promote_missing_hero_media"
  );
  passed += 1;

  // missing expected Media Library record aborts
  assertThrows(
    () =>
      buildProductionPromotePlan({
        line: fixtureLine(NCL_ID, "NCL"),
        ships: [],
        mediaRows: [],
        lineId: NCL_ID
      }),
    "production_promote_missing_logo_media"
  );
  passed += 1;

  // source URL mismatch aborts
  assertThrows(
    () =>
      buildProductionPromotePlan({
        line: fixtureLine(NCL_ID, "NCL", "https://images.squarespace-cdn.com/other.png"),
        ships: [],
        mediaRows: [logoMedia(NCL_ID)],
        lineId: NCL_ID
      }),
    "production_promote_source_mismatch"
  );
  passed += 1;

  // more than 10 candidates aborts (copy plan)
  const eleven = Array.from({ length: 11 }, (_, i) => ({
    entity_id: `e${i}`,
    cruise_line_id: NCL_ID,
    status: "proposed_upload",
    bytes: 10,
    oversized: false
  }));
  assertThrows(
    () => assertProductionCopyPlan({ inspected: eleven, summary: { broken_urls: 0 }, lineId: NCL_ID }),
    "production_copy_candidate_count"
  );
  passed += 1;

  // candidate from another line aborts (copy)
  assertThrows(
    () =>
      assertProductionCopyPlan({
        inspected: [
          {
            entity_id: "x",
            cruise_line_id: OTHER_LINE,
            status: "proposed_upload",
            bytes: 1,
            oversized: false
          }
        ],
        summary: { broken_urls: 0, invalid_mime_types: 0, ssrf_blocked: 0, too_large: 0 },
        lineId: NCL_ID
      }),
    "production_copy_foreign_line"
  );
  passed += 1;

  // copy does not change CI URLs
  assert(assertCopyDidNotChangeCiUrls([{ ci_url_changed: false }]) === true, "ci unchanged");
  assertThrows(
    () => assertCopyDidNotChangeCiUrls([{ ci_url_changed: true }]),
    "production_copy_ci_url_changed"
  );
  passed += 1;

  // banner includes required fields
  const banner = formatProductionPromoteBanner(nclPlan, PRODUCTION_REF);
  assert(banner.includes("Original project"), "banner original");
  assert(banner.includes(NCL_ID), "banner uuid");
  assert(banner.includes("Norwegian Cruise Line"), "banner name");
  assert(banner.includes("uploads during promote: 0"), "banner uploads");
  assert(banner.includes("Media Library inserts during promote: 0"), "banner inserts");
  assert(banner.includes(PRODUCTION_PROMOTE_ADMIN_WARNING), "banner warning");
  passed += 1;

  await assertProductionPromotePublicUrls(nclPlan, async () => true);
  await assertThrowsAsync(
    () => assertProductionPromotePublicUrls(nclPlan, async () => false),
    "production_promote_public_url_unreachable"
  );
  passed += 1;

  const manifest = buildProductionPromoteManifest(nclPlan, {
    projectRef: PRODUCTION_REF,
    timestamp: "2026-07-25T00:00:00.000Z"
  });
  assert(manifest.kind === "production_promote_single_line", "manifest kind");
  assert(manifest.entries.length === 1, "one entry");
  assert(String(manifest.guarded_restore_command).includes(NCL_ID), "manifest uuid");
  passed += 1;

  // verified PATCH safeguards + compensating rollback
  const writes = [];
  const ok = await applyVerifiedSequentialProductionPromote(nclPlan, {
    verifiedWrite: async (p) => {
      writes.push(p);
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
  assert(ok.strategy === "verified_sequential_update_with_compensating_rollback", "strategy");
  assert(writes.length === 1 && writes[0].field === "logo_url", "logo write");
  passed += 1;

  const state = { logo: SQ_LOGO, hero: SQ_HERO };
  let calls = 0;
  await assertThrowsAsync(
    () =>
      applyVerifiedSequentialProductionPromote(mixedPlan, {
        verifiedWrite: async ({ id, field, value }) => {
          calls += 1;
          if (calls === 2) {
            throw Object.assign(new Error("second failed"), { code: "patch_http_error" });
          }
          if (field === "logo_url") state.logo = value;
          if (field === "hero_image_url") state.hero = value;
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
  assert(state.logo === SQ_LOGO, "logo restored");
  passed += 1;

  // historical Princess line id constant still exported for docs/tests
  assert(PRODUCTION_COPY_ALLOWED_LINE_ID === PRINCESS_ID, "princess id");
  passed += 1;

  console.log(`PASS ${passed} squarespace general single-line promote/copy gate tests`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
