/**
 * Offline fixture tests for CI catalogue prod → DEV copy planner.
 * No network. No Supabase. No writes.
 */

import {
  PRODUCTION_REF,
  DEV_REF,
  TABLES,
  assertCopyRefs,
  projectRefFromUrl,
  intersectColumns,
  planCatalogueCopy,
  planTableCopy,
  assertApplyOrder,
  createReadOnlyProductionGuard,
  rowsEqual,
  projectRow
} from "./lib/copy-ci-catalogue/plan.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function run() {
  let passed = 0;

  assert(
    projectRefFromUrl("https://xikbibxyinttllxamgao.supabase.co") === PRODUCTION_REF,
    "prod ref parse"
  );
  passed += 1;
  assert(
    projectRefFromUrl("https://vkheexbapykcdfbqcach.supabase.co") === DEV_REF,
    "dev ref parse"
  );
  passed += 1;

  assertCopyRefs(PRODUCTION_REF, DEV_REF);
  passed += 1;

  for (const [fn, code] of [
    [() => assertCopyRefs(DEV_REF, PRODUCTION_REF), "reversed_refs"],
    [() => assertCopyRefs(PRODUCTION_REF, PRODUCTION_REF), "identical_refs"],
    [() => assertCopyRefs("abcdefghhijklmno", DEV_REF), "unknown_source_ref"],
    [() => assertCopyRefs(PRODUCTION_REF, "zzzzzzzzzzzzzzzzzz"), "unknown_dest_ref"]
  ]) {
    let ok = false;
    try {
      fn();
    } catch (e) {
      ok = e.code === code;
    }
    assert(ok, code);
    passed += 1;
  }

  assert(
    TABLES.join(",") === "ci_cruise_lines,ci_cruise_ships,cruise_ship_aliases",
    "copy order"
  );
  passed += 1;

  const done = new Set();
  let orderFail = false;
  try {
    assertApplyOrder(done, "ci_cruise_ships");
  } catch (e) {
    orderFail = e.code === "order_violation";
  }
  assert(orderFail, "ships before lines rejected");
  passed += 1;
  done.add("ci_cruise_lines");
  assertApplyOrder(done, "ci_cruise_ships");
  done.add("ci_cruise_ships");
  assertApplyOrder(done, "cruise_ship_aliases");
  passed += 1;

  const lineId = "11111111-1111-1111-1111-111111111111";
  const shipId = "22222222-2222-2222-2222-222222222222";
  const aliasId = "33333333-3333-3333-3333-333333333333";
  const lineCols = ["id", "name", "slug", "logo_url", "active", "sold_by_101cruise"];
  const shipCols = ["id", "cruise_line_id", "name", "slug", "hero_image_url", "active"];
  const aliasCols = [
    "id",
    "ship_id",
    "cruise_line_id",
    "raw_alias",
    "normalised_alias",
    "active"
  ];

  const sourceLines = [
    {
      id: lineId,
      name: "Princess Cruises",
      slug: "princess-cruises",
      logo_url: "https://example.com/logo.png",
      active: true,
      sold_by_101cruise: true
    }
  ];
  const sourceShips = [
    {
      id: shipId,
      cruise_line_id: lineId,
      name: "Discovery Princess",
      slug: "discovery-princess",
      hero_image_url: "https://example.com/hero.jpg",
      active: true
    }
  ];
  const sourceAliases = [
    {
      id: aliasId,
      ship_id: shipId,
      cruise_line_id: lineId,
      raw_alias: "Discovery",
      normalised_alias: "discovery",
      active: true
    }
  ];

  const planEmpty = planCatalogueCopy({
    sourceLines,
    sourceShips,
    sourceAliases,
    destLines: [],
    destShips: [],
    destAliases: [],
    lineColumns: lineCols,
    shipColumns: shipCols,
    aliasColumns: aliasCols
  });
  assert(planEmpty.lines.creates[0].id === lineId, "uuid preserved");
  assert(planEmpty.ships.creates[0].cruise_line_id === lineId, "fk preserved");
  assert(planEmpty.order[0] === "ci_cruise_lines", "order lines");
  assert(planEmpty.order[1] === "ci_cruise_ships", "order ships");
  assert(planEmpty.order[2] === "cruise_ship_aliases", "order aliases");
  assert(planEmpty.lines.create_count === 1, "lines before ships create");
  assert(planEmpty.ships.create_count === 1, "ships create");
  assert(planEmpty.aliases.create_count === 1, "aliases after ships");
  passed += 1;

  const badShipPlan = planTableCopy({
    table: "ci_cruise_ships",
    columns: shipCols,
    sourceRows: [
      {
        id: "44444444-4444-4444-4444-444444444444",
        cruise_line_id: "99999999-9999-9999-9999-999999999999",
        name: "Orphan",
        slug: "orphan",
        active: true
      }
    ],
    destRows: [],
    parentValidators: (row) =>
      row.cruise_line_id === lineId ? null : "ship_references_missing_line"
  });
  assert(badShipPlan.invalid_count === 1, "missing parent line");
  passed += 1;

  const badAlias = planCatalogueCopy({
    sourceLines,
    sourceShips,
    sourceAliases: [
      {
        id: "55555555-5555-5555-5555-555555555555",
        ship_id: "99999999-9999-9999-9999-999999999999",
        cruise_line_id: lineId,
        raw_alias: "x",
        normalised_alias: "x",
        active: true
      }
    ],
    destLines: [],
    destShips: [],
    destAliases: [],
    lineColumns: lineCols,
    shipColumns: shipCols,
    aliasColumns: aliasCols
  });
  assert(
    badAlias.aliases.invalid[0].reason === "alias_references_missing_ship",
    "missing ship"
  );
  passed += 1;

  const planRepeat = planCatalogueCopy({
    sourceLines,
    sourceShips,
    sourceAliases,
    destLines: sourceLines,
    destShips: sourceShips,
    destAliases: sourceAliases,
    lineColumns: lineCols,
    shipColumns: shipCols,
    aliasColumns: aliasCols
  });
  assert(
    planRepeat.lines.create_count +
      planRepeat.ships.create_count +
      planRepeat.aliases.create_count ===
      0,
    "zero duplicates"
  );
  passed += 1;

  const planUpdate = planCatalogueCopy({
    sourceLines,
    sourceShips,
    sourceAliases,
    destLines: [{ ...sourceLines[0], logo_url: "https://example.com/old.png" }],
    destShips: sourceShips,
    destAliases: sourceAliases,
    lineColumns: lineCols,
    shipColumns: shipCols,
    aliasColumns: aliasCols
  });
  assert(planUpdate.lines.update_count === 1, "update detection");
  passed += 1;

  const planExtras = planCatalogueCopy({
    sourceLines,
    sourceShips,
    sourceAliases,
    destLines: [
      ...sourceLines,
      {
        id: "66666666-6666-6666-6666-666666666666",
        name: "Extra",
        slug: "extra",
        active: true,
        sold_by_101cruise: false,
        logo_url: null
      }
    ],
    destShips: sourceShips,
    destAliases: sourceAliases,
    lineColumns: lineCols,
    shipColumns: shipCols,
    aliasColumns: aliasCols
  });
  assert(planExtras.lines.dest_extra_rows_retained === 1, "no deletion of extras");
  assert(planExtras.would_delete_dev_rows === false, "no destructive sync");
  passed += 1;

  const guard = createReadOnlyProductionGuard("production");
  let blocked = false;
  try {
    await guard.upsert();
  } catch (e) {
    blocked = e.code === "production_write_forbidden";
  }
  assert(blocked, "production write impossible");
  passed += 1;
  blocked = false;
  try {
    await guard.delete();
  } catch (e) {
    blocked = e.code === "production_write_forbidden";
  }
  assert(blocked, "production delete impossible");
  passed += 1;

  const dryRunMode = !process.argv.includes("--apply");
  assert(dryRunMode === true, "default dry-run (no --apply in test argv)");
  passed += 1;

  const shared = intersectColumns(
    ["id", "name", "ship_naming_style", "logo_url"],
    ["id", "name", "logo_url", "dev_only_col"],
    ["id", "name", "logo_url", "ship_naming_style"]
  );
  assert(
    !shared.includes("ship_naming_style") && !shared.includes("dev_only_col"),
    "intersect"
  );
  passed += 1;

  assert(
    rowsEqual(
      projectRow(sourceLines[0], lineCols),
      projectRow(sourceLines[0], lineCols),
      lineCols
    ),
    "equal"
  );
  passed += 1;

  console.log(`PASS ${passed} copy-ci-catalogue fixture tests`);
}

run().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
