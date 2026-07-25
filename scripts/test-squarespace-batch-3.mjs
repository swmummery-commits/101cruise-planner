/**
 * Offline tests for Batch 3 Disney Cruise Line runner.
 * No network. No credentials. No live DB writes.
 */

import {
  BATCH_1_ID,
  BATCH_1_CONFIRM_TOKEN,
  BATCH_1_LINES,
  getApprovedBatch,
  assertProductionBatchCliGate,
  assertBatch1LogoOnlyScope
} from "./lib/squarespace-ci-media/batch-1-logo-lines.js";
import {
  BATCH_2_ID,
  BATCH_2_CONFIRM_TOKEN,
  BATCH_2_LINES,
  getBatch2Config,
  assertBatch2MixedScope
} from "./lib/squarespace-ci-media/batch-2-mixed-lines.js";
import {
  BATCH_3_ID,
  BATCH_3_CONFIRM_TOKEN,
  BATCH_3_LINES,
  BATCH_3_LINE_IDS,
  BATCH_3_SHIP_IDS,
  DISNEY_CRUISE_LINE_ID,
  DISNEY_CRUISE_LINE_NAME,
  getBatch3Config,
  assertBatch3DisneyScope,
  assertBatch3PromotePlan
} from "./lib/squarespace-ci-media/batch-3-disney.js";
import {
  runApprovedBatch,
  summariseCopyResults
} from "./lib/squarespace-ci-media/batch-runner.js";
import { assertExactOnePatchedRow } from "./lib/squarespace-ci-media/verified-ci-patch.js";
import { resolveMigrationTarget, DEV_REF, PRODUCTION_REF } from "./lib/squarespace-ci-media/target.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertThrows(fn, code) {
  let ok = false;
  try {
    fn();
  } catch (e) {
    ok = e.code === code;
    if (!ok) throw new Error(`expected ${code}, got ${e.code}: ${e.message}`);
  }
  assert(ok, `expected throw ${code}`);
}

function okScope(approved, overrides = {}) {
  return {
    approved,
    logoCandidates: overrides.logoCandidates ?? [
      { url: "logo", cruise_line_id: DISNEY_CRUISE_LINE_ID }
    ],
    shipHeroCandidates:
      overrides.shipHeroCandidates ??
      approved.ships.map((s) => ({
        ship_id: s.id,
        name: s.name,
        cruise_line_id: DISNEY_CRUISE_LINE_ID,
        url: "hero"
      }))
  };
}

async function main() {
  let passed = 0;
  const batch = getBatch3Config();
  const viaRegistry = getApprovedBatch(BATCH_3_ID);
  const disney = batch.lines[0];

  // exactly one line; fixed UUID/name
  assert(batch.lines.length === 1, "one line");
  assert(BATCH_3_LINES.length === 1, "frozen one");
  assert(BATCH_3_LINE_IDS.length === 1, "one id");
  assert(BATCH_3_SHIP_IDS.length === 7, "seven ships");
  assert(batch.disney_only === true, "disney only");
  assert(batch.expected_total_assets === 8, "8 assets");
  assert(disney.id === DISNEY_CRUISE_LINE_ID, "disney uuid");
  assert(disney.name === DISNEY_CRUISE_LINE_NAME, "disney name");
  assert(disney.id === "8f7aadcb-7843-4060-b0cb-a60631936b3a", "fixed uuid");
  assert(disney.name === "Disney Cruise Line", "fixed name");
  assert(viaRegistry.id === BATCH_3_ID, "registry");
  assert(viaRegistry.confirm_token === BATCH_3_CONFIRM_TOKEN, "token");
  passed += 1;

  // fixed counts
  assert(disney.expected_logo_count === 1, "1 logo");
  assert(disney.expected_ship_hero_count === 7, "7 ships");
  assert(disney.expected_total === 8, "total 8");
  assert(
    disney.ships.map((s) => s.name).join("|") ===
      [
        "Disney Magic",
        "Disney Adventure",
        "Disney Wish",
        "Disney Treasure",
        "Disney Fantasy",
        "Disney Dream",
        "Disney Wonder"
      ].join("|"),
    "exact ship names"
  );
  passed += 1;

  // CLI gate
  assert(
    assertProductionBatchCliGate({
      target: "production",
      mode: "dry-run",
      batchId: BATCH_3_ID,
      confirmToken: BATCH_3_CONFIRM_TOKEN
    }).id === BATCH_3_ID,
    "cli ok"
  );
  assertThrows(
    () =>
      assertProductionBatchCliGate({
        target: "production",
        mode: "copy",
        batchId: BATCH_3_ID,
        confirmToken: "BATCH-2-MIXED"
      }),
    "batch_confirm_invalid"
  );
  assertThrows(
    () =>
      assertProductionBatchCliGate({
        target: "dev",
        mode: "copy",
        batchId: BATCH_3_ID,
        confirmToken: BATCH_3_CONFIRM_TOKEN
      }),
    "batch_target_invalid"
  );
  passed += 1;

  assertBatch3DisneyScope(okScope(disney));
  passed += 1;

  // unexpected logo count aborts
  assertThrows(
    () => assertBatch3DisneyScope(okScope(disney, { logoCandidates: [] })),
    "batch3_unexpected_logo_count"
  );
  assertThrows(
    () => assertBatch3DisneyScope(okScope(disney, { logoCandidates: [{}, {}] })),
    "batch3_unexpected_logo_count"
  );
  passed += 1;

  // unexpected ship count / total = 8
  assertThrows(
    () =>
      assertBatch3DisneyScope(
        okScope(disney, {
          shipHeroCandidates: disney.ships.slice(0, 6).map((s) => ({
            ship_id: s.id,
            name: s.name,
            cruise_line_id: DISNEY_CRUISE_LINE_ID
          }))
        })
      ),
    "batch3_unexpected_ship_count"
  );
  passed += 1;

  // unexpected ship name aborts (UUID/name pair swap)
  assertThrows(
    () =>
      assertBatch3DisneyScope(
        okScope(disney, {
          shipHeroCandidates: [
            {
              ship_id: disney.ships[0].id,
              name: disney.ships[1].name,
              cruise_line_id: DISNEY_CRUISE_LINE_ID
            },
            {
              ship_id: disney.ships[1].id,
              name: disney.ships[0].name,
              cruise_line_id: DISNEY_CRUISE_LINE_ID
            },
            ...disney.ships.slice(2).map((s) => ({
              ship_id: s.id,
              name: s.name,
              cruise_line_id: DISNEY_CRUISE_LINE_ID
            }))
          ]
        })
      ),
    "batch3_unexpected_ship_name"
  );
  passed += 1;

  // missing ship aborts
  assertThrows(
    () =>
      assertBatch3DisneyScope(
        okScope(disney, {
          shipHeroCandidates: [
            ...disney.ships.slice(0, 6).map((s) => ({
              ship_id: s.id,
              name: s.name,
              cruise_line_id: DISNEY_CRUISE_LINE_ID
            })),
            {
              ship_id: "00000000-0000-0000-0000-000000000099",
              name: disney.ships[6].name,
              cruise_line_id: DISNEY_CRUISE_LINE_ID
            }
          ]
        })
      ),
    "batch3_missing_ship"
  );
  passed += 1;

  // extra ship aborts
  assertThrows(
    () =>
      assertBatch3DisneyScope(
        okScope(disney, {
          shipHeroCandidates: [
            ...disney.ships.map((s) => ({
              ship_id: s.id,
              name: s.name,
              cruise_line_id: DISNEY_CRUISE_LINE_ID
            })),
            {
              ship_id: "11111111-1111-1111-1111-111111111111",
              name: "Extra Ship",
              cruise_line_id: DISNEY_CRUISE_LINE_ID
            }
          ]
        })
      ),
    "batch3_unexpected_ship_count"
  );
  passed += 1;

  // ship owned by another line aborts
  assertThrows(
    () =>
      assertBatch3DisneyScope(
        okScope(disney, {
          shipHeroCandidates: [
            {
              ship_id: disney.ships[0].id,
              name: disney.ships[0].name,
              cruise_line_id: "aa2c50ed-7ff5-472d-bc96-3d686d76c5ec"
            },
            ...disney.ships.slice(1).map((s) => ({
              ship_id: s.id,
              name: s.name,
              cruise_line_id: DISNEY_CRUISE_LINE_ID
            }))
          ]
        })
      ),
    "batch3_foreign_candidate"
  );
  passed += 1;

  // candidate from another line aborts (logo)
  assertThrows(
    () =>
      assertBatch3DisneyScope(
        okScope(disney, {
          logoCandidates: [
            {
              url: "x",
              cruise_line_id: "aa2c50ed-7ff5-472d-bc96-3d686d76c5ec"
            }
          ]
        })
      ),
    "batch3_foreign_candidate"
  );
  passed += 1;

  // non-Disney line rejected
  assertThrows(
    () =>
      assertBatch3DisneyScope(
        okScope({
          ...disney,
          id: "aa2c50ed-7ff5-472d-bc96-3d686d76c5ec",
          name: "Celebrity Cruises"
        })
      ),
    "batch3_non_disney_line"
  );
  passed += 1;

  // promote plan gates
  const goodPlan = {
    line_id: DISNEY_CRUISE_LINE_ID,
    updates: [
      {
        table: "ci_cruise_lines",
        field: "logo_url",
        entity_uuid: DISNEY_CRUISE_LINE_ID,
        entity_type: "cruise_line"
      },
      ...disney.ships.map((s) => ({
        table: "ci_cruise_ships",
        field: "hero_image_url",
        entity_uuid: s.id,
        entity_type: "ship"
      }))
    ]
  };
  assert(goodPlan.updates.length === 8, "8 promote fields");
  assertBatch3PromotePlan(goodPlan, disney);
  assertThrows(
    () =>
      assertBatch3PromotePlan({ ...goodPlan, updates: goodPlan.updates.slice(0, 7) }, disney),
    "batch3_promote_count_mismatch"
  );
  assertThrows(
    () =>
      assertBatch3PromotePlan(
        {
          line_id: DISNEY_CRUISE_LINE_ID,
          updates: [
            ...goodPlan.updates.slice(0, 7),
            {
              table: "ci_cruise_ships",
              field: "hero_image_url",
              entity_uuid: "193071d7-46ee-438f-9025-ff9551ce4aa2",
              entity_type: "ship"
            }
          ]
        },
        disney
      ),
    "batch3_promote_ship_not_approved"
  );
  assertThrows(
    () =>
      assertBatch3PromotePlan(
        {
          line_id: DISNEY_CRUISE_LINE_ID,
          updates: [
            {
              table: "ci_cruise_lines",
              field: "description",
              entity_uuid: DISNEY_CRUISE_LINE_ID
            },
            ...goodPlan.updates.slice(1)
          ]
        },
        disney
      ),
    "batch3_promote_field_forbidden"
  );
  passed += 1;

  // dry-run zero writes
  const dry = await runApprovedBatch({
    mode: "dry-run",
    batch,
    projectRef: PRODUCTION_REF,
    loadCatalogue: async () => ({ lines: [], ships: [], media: [] }),
    processLine: async ({ approved }) => ({
      order: approved.order,
      line_id: approved.id,
      line_name: approved.name,
      status: "ok",
      wrote: false,
      uploaded_count: 0,
      skipped_already_migrated: 0,
      promoted_fields: [],
      bytes_uploaded: 0,
      report_path: "r-1.json",
      rollback_manifest_path: null
    })
  });
  assert(dry.original_project_writes === 0, "dry writes 0");
  assert(dry.dev_writes === 0, "dev 0");
  assert(dry.completed_lines === 1, "one dry");
  passed += 1;

  // copy: Storage + Media Library only
  const copy = await runApprovedBatch({
    mode: "copy",
    batch,
    projectRef: PRODUCTION_REF,
    loadCatalogue: async () => ({ lines: [], ships: [], media: [] }),
    processLine: async ({ approved }) => ({
      order: approved.order,
      line_id: approved.id,
      line_name: approved.name,
      status: "ok",
      wrote: true,
      uploaded_count: 8,
      logos_uploaded: 1,
      ship_heroes_uploaded: 7,
      media_library_inserted_count: 8,
      skipped_already_migrated: 0,
      bytes_uploaded: 1636056,
      promoted_fields: [],
      ci_urls_changed: 0,
      report_path: "c-1.json",
      rollback_manifest_path: null
    })
  });
  assert(copy.uploaded_assets === 8, "8 uploads");
  assert(copy.dev_writes === 0, "copy dev 0");
  assert((copy.lines[0].promoted_fields || []).length === 0, "copy no promote");
  assertThrows(
    () => summariseCopyResults([{ copy_result: "uploaded", ci_url_changed: true }]),
    "batch_copy_ci_url_changed"
  );
  passed += 1;

  // promote: only Disney logo + heroes; no upload/insert; manifests
  const promote = await runApprovedBatch({
    mode: "promote",
    batch,
    projectRef: PRODUCTION_REF,
    loadCatalogue: async () => ({ lines: [], ships: [], media: [] }),
    processLine: async ({ approved }) => ({
      order: approved.order,
      line_id: approved.id,
      line_name: approved.name,
      status: "ok",
      wrote: true,
      uploaded_count: 0,
      media_library_inserted_count: 0,
      logos_uploaded: 0,
      ship_heroes_uploaded: 0,
      skipped_already_migrated: 0,
      bytes_uploaded: 0,
      logos_promoted: 1,
      ship_heroes_promoted: 7,
      promoted_fields: [
        "ci_cruise_lines.logo_url",
        ...approved.ships.map(() => "ci_cruise_ships.hero_image_url")
      ],
      report_path: "p-1.json",
      rollback_manifest_path: "m-1.json"
    })
  });
  assert(promote.promoted_fields === 8, "8 promoted");
  assert(promote.rollback_manifest_paths.length === 1, "manifest path");
  assert(promote.uploaded_assets === 0, "no upload");
  assert((promote.lines[0].media_library_inserted_count || 0) === 0, "no insert");
  assert(
    promote.lines[0].promoted_fields.every(
      (f) => f === "ci_cruise_lines.logo_url" || f === "ci_cruise_ships.hero_image_url"
    ),
    "only logo/hero"
  );
  assert(promote.lines[0].promoted_fields.length === 8, "8 fields listed");
  passed += 1;

  // verified PATCH + re-read
  assertThrows(
    () =>
      assertExactOnePatchedRow([], {
        entityUuid: DISNEY_CRUISE_LINE_ID,
        field: "logo_url",
        expectedValue: "https://x.supabase.co/x"
      }),
    "patch_zero_rows"
  );
  assertThrows(
    () =>
      assertExactOnePatchedRow(
        [{ id: DISNEY_CRUISE_LINE_ID, logo_url: "https://wrong" }],
        {
          entityUuid: DISNEY_CRUISE_LINE_ID,
          field: "logo_url",
          expectedValue: "https://x.supabase.co/x"
        }
      ),
    "patch_wrong_field_value"
  );
  passed += 1;

  // Batch 1 unchanged
  const batch1 = getApprovedBatch(BATCH_1_ID);
  assert(batch1.lines.length === 13, "batch1 13");
  assert(BATCH_1_LINES.length === 13, "batch1 frozen");
  assertBatch1LogoOnlyScope({
    logoCandidates: [{}],
    shipHeroCandidates: [],
    lineName: "NCL"
  });
  assert(
    assertProductionBatchCliGate({
      target: "production",
      mode: "dry-run",
      batchId: BATCH_1_ID,
      confirmToken: BATCH_1_CONFIRM_TOKEN
    }).id === BATCH_1_ID,
    "batch1 cli"
  );
  passed += 1;

  // Batch 2 unchanged + still excludes Disney
  const batch2 = getBatch2Config();
  assert(batch2.lines.length === 6, "batch2 six");
  assert(BATCH_2_LINES.length === 6, "batch2 frozen");
  assert(batch2.excludes_disney === true, "batch2 excludes disney");
  assert(!BATCH_2_LINES.some((l) => l.id === DISNEY_CRUISE_LINE_ID), "no disney in b2");
  assertBatch2MixedScope({
    approved: BATCH_2_LINES[0],
    logoCandidates: [{}],
    shipHeroCandidates: BATCH_2_LINES[0].ships.map((s) => ({
      ship_id: s.id,
      name: s.name
    }))
  });
  assert(
    assertProductionBatchCliGate({
      target: "production",
      mode: "dry-run",
      batchId: BATCH_2_ID,
      confirmToken: BATCH_2_CONFIRM_TOKEN
    }).id === BATCH_2_ID,
    "batch2 cli"
  );
  passed += 1;

  // DEV untouched
  const mixedEnv = {
    SUPABASE_DEV_URL: `https://${DEV_REF}.supabase.co`,
    SUPABASE_DEV_SERVICE_ROLE_KEY: "dev-secret",
    SUPABASE_URL: `https://${PRODUCTION_REF}.supabase.co`,
    SUPABASE_SERVICE_ROLE_KEY: "prod-secret"
  };
  const dev = resolveMigrationTarget({ target: "dev", mode: "copy", env: mixedEnv });
  assert(dev.writes_allowed === true, "dev single-line still works");
  assertThrows(
    () =>
      assertProductionBatchCliGate({
        target: "dev",
        mode: "promote",
        batchId: BATCH_3_ID,
        confirmToken: BATCH_3_CONFIRM_TOKEN
      }),
    "batch_target_invalid"
  );
  assert(dry.dev_writes === 0 && copy.dev_writes === 0 && promote.dev_writes === 0, "dev 0");
  passed += 1;

  console.log(`PASS ${passed} squarespace batch-3-disney tests`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
