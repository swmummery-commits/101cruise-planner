#!/usr/bin/env node
/**
 * Regression tests for authoritative Supabase counts above PostgREST default limits.
 *   node scripts/test-supabase-count.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { exactCountSupabase, fetchAllPaginated } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const CELEBRITY_LINE_ID = "aa2c50ed-7ff5-472d-bc96-3d686d76c5ec";

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

async function main() {
  await test("exactCountSupabase returns numeric count object", async () => {
    const result = await exactCountSupabase(
      root,
      "discovered_cruises",
      `cruise_line_id=eq.${CELEBRITY_LINE_ID}&status=eq.active`
    );
    if (typeof result.count !== "number") throw new Error("expected numeric count");
    if (result.count < 1) throw new Error("expected positive count");
  });

  await test("Celebrity active exact count exceeds default 1000-row page", async () => {
    const exact = await exactCountSupabase(
      root,
      "discovered_cruises",
      `cruise_line_id=eq.${CELEBRITY_LINE_ID}&status=eq.active`
    );
    const page = await fetchAllPaginated(
      root,
      `discovered_cruises?cruise_line_id=eq.${CELEBRITY_LINE_ID}&status=eq.active&select=id`,
      { pageSize: 1000, maxRows: 1000 }
    );
    if (exact.count <= 1000) throw new Error("expected Celebrity active count above regression threshold");
    if (page.length !== 1000) throw new Error("expected first page capped at 1000 rows");
    if (exact.count === page.length) {
      throw new Error("exact count must not rely on single-page row length when count > 1000");
    }
    if (exact.count < 1200) throw new Error(`expected Celebrity active around 1204, got ${exact.count}`);
  });

  await test("fetchAllPaginated loads more than one page when required", async () => {
    const rows = await fetchAllPaginated(
      root,
      `discovered_cruises?cruise_line_id=eq.${CELEBRITY_LINE_ID}&status=eq.active&select=id`,
      { pageSize: 1000 }
    );
    const exact = await exactCountSupabase(
      root,
      "discovered_cruises",
      `cruise_line_id=eq.${CELEBRITY_LINE_ID}&status=eq.active`
    );
    if (rows.length !== exact.count) {
      throw new Error(`paginated rows (${rows.length}) must match exact count (${exact.count})`);
    }
  });

  await test("verify script uses exactCountSupabase helper", async () => {
    const src = fs.readFileSync(path.join(root, "scripts/verify-princess-production-records.mjs"), "utf8");
    if (!src.includes("exactCountSupabase")) throw new Error("verify script missing exact count");
    if (!src.includes("actualActiveExact")) throw new Error("verify script still uses row length as authoritative count");
  });

  await test("CI smoke script uses existing maintenance runner and forbids writes", async () => {
    const src = fs.readFileSync(path.join(root, "scripts/princess-source-smoke-ci.mjs"), "utf8");
    if (!src.includes("runPrincessWeeklyMaintenance")) throw new Error("CI smoke must use maintenance runner");
    if (!src.includes("performWrites: false")) throw new Error("CI smoke must disable writes");
    if (!src.includes("inventory_writes_performed: false")) throw new Error("missing zero-write confirmation");
    if (!src.includes("exactCountSupabase")) throw new Error("CI smoke must use exact counts");
  });

  await test("GitHub workflow is workflow_dispatch only with write flags disabled", async () => {
    const wf = fs.readFileSync(path.join(root, ".github/workflows/princess-source-smoke.yml"), "utf8");
    if (!wf.includes("workflow_dispatch")) throw new Error("workflow must support manual dispatch");
    if (/^\s*schedule:/m.test(wf)) throw new Error("workflow must not be scheduled");
    if (!wf.includes('PRINCESS_DISCOVERY_WRITE_ENABLED: "false"')) {
      throw new Error("workflow must disable Princess write flag");
    }
    if (!wf.includes("secrets.SUPABASE_URL")) throw new Error("workflow missing SUPABASE_URL secret");
  });

  console.log(`\ntest-supabase-count: ${passed} passed`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
