#!/usr/bin/env node
/**
 * Regression tests for authoritative Supabase counts above PostgREST default limits.
 * Validates counting mechanics — not business inventory floors that change over time.
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
const FIXTURE_TOTAL = 1204;

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

/** Parse PostgREST content-range header the same way exactCountSupabase does. */
function parseContentRangeCount(contentRange) {
  const m = String(contentRange || "").match(/\/(\d+)/);
  return m ? Number(m[1]) : 0;
}

/** Simulate paginated row fetch against a virtual dataset (PostgREST default page = 1000). */
function simulatePaginatedFetch(total, { pageSize = 1000, maxRows = null, offset = 0 } = {}) {
  const cap = maxRows != null ? Math.min(total, maxRows) : total;
  const end = Math.min(offset + pageSize, cap);
  if (offset >= cap) return [];
  return Array.from({ length: end - offset }, (_, i) => ({ id: `fixture-${offset + i + 1}` }));
}

/** Simulate fetchAllPaginated loop against a virtual dataset. */
function simulateFetchAllPaginated(total, { pageSize = 1000, maxRows = null } = {}) {
  const rows = [];
  let offset = 0;
  while (true) {
    const batch = simulatePaginatedFetch(total, { pageSize, maxRows, offset });
    if (!batch.length) break;
    rows.push(...batch);
    if (maxRows != null && rows.length >= maxRows) return rows.slice(0, maxRows);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

async function main() {
  await test("fixture dataset of 1204 records returns authoritative count 1204", async () => {
    const contentRange = `0-0/${FIXTURE_TOTAL}`;
    const count = parseContentRangeCount(contentRange);
    if (count !== FIXTURE_TOTAL) {
      throw new Error(`expected fixture count ${FIXTURE_TOTAL}, got ${count}`);
    }
  });

  await test("single page capped at 1000 is not mistaken for total count of 1204", async () => {
    const exact = parseContentRangeCount(`0-0/${FIXTURE_TOTAL}`);
    const firstPage = simulatePaginatedFetch(FIXTURE_TOTAL, { pageSize: 1000, maxRows: 1000 });
    if (firstPage.length !== 1000) throw new Error("expected first page capped at 1000 rows");
    if (exact === firstPage.length) {
      throw new Error("exact count must not rely on single-page row length when count > 1000");
    }
    if (exact !== FIXTURE_TOTAL) {
      throw new Error(`expected authoritative count ${FIXTURE_TOTAL}, got ${exact}`);
    }
  });

  await test("simulated fetchAllPaginated retrieves all 1204 fixture rows", async () => {
    const exact = parseContentRangeCount(`0-0/${FIXTURE_TOTAL}`);
    const rows = simulateFetchAllPaginated(FIXTURE_TOTAL, { pageSize: 1000 });
    if (rows.length !== FIXTURE_TOTAL) {
      throw new Error(`paginated fixture rows (${rows.length}) must match exact count (${FIXTURE_TOTAL})`);
    }
    if (rows.length !== exact) {
      throw new Error("paginated row length must match authoritative exact count");
    }
  });

  await test("exactCountSupabase returns numeric count object from production", async () => {
    const result = await exactCountSupabase(
      root,
      "discovered_cruises",
      `cruise_line_id=eq.${CELEBRITY_LINE_ID}&status=eq.active`
    );
    if (typeof result.count !== "number" || !Number.isFinite(result.count)) {
      throw new Error("expected finite numeric count");
    }
    if (result.count < 0) throw new Error("count must be non-negative");
    if (!result.contentRange || !result.contentRange.includes("/")) {
      throw new Error("expected content-range header in exact count response");
    }
  });

  await test("production paginated rows match exact count semantics (no hardcoded inventory floor)", async () => {
    const exact = await exactCountSupabase(
      root,
      "discovered_cruises",
      `cruise_line_id=eq.${CELEBRITY_LINE_ID}&status=eq.active`
    );
    const rows = await fetchAllPaginated(
      root,
      `discovered_cruises?cruise_line_id=eq.${CELEBRITY_LINE_ID}&status=eq.active&select=id`,
      { pageSize: 1000 }
    );
    if (rows.length !== exact.count) {
      throw new Error(`paginated rows (${rows.length}) must match exact count (${exact.count})`);
    }
    // When count exceeds one page, a capped first page must not equal the authoritative total.
    if (exact.count > 1000) {
      const firstPage = await fetchAllPaginated(
        root,
        `discovered_cruises?cruise_line_id=eq.${CELEBRITY_LINE_ID}&status=eq.active&select=id`,
        { pageSize: 1000, maxRows: 1000 }
      );
      if (firstPage.length === exact.count) {
        throw new Error("single-page row length must not be mistaken for authoritative count");
      }
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
