#!/usr/bin/env node
/**
 * Royal Caribbean Prompt 10 activation — manifest, ceilings, schedule config tests.
 *   npm run test:royal-caribbean-prompt10-activation
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const manifestMod = require(path.join(root, "netlify/functions/lib/royal-caribbean-weekly-manifest"));
const cli = require(path.join(root, "netlify/functions/lib/royal-caribbean-weekly-maintenance-cli"));
const maintenance = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));
const { ROYAL_CARIBBEAN_WEEKLY_WRITE_CEILING } = require(path.join(
  root,
  "netlify/functions/lib/royal-caribbean-weekly-health"
));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`✗ ${name} — ${error.message || error}`);
  }
}

function sampleDryRunResult() {
  return {
    summary: {
      run_id: "test-run",
      source_snapshot_id: "snap123",
      update_analysis: {
        safe_proposed_updates: [
          {
            official_sailing_id: "OA07W123_2027-01-01",
            safe_fields: ["official_url"],
            changed_fields: [{ field: "official_url" }]
          }
        ],
        review_required_updates: [
          {
            official_sailing_id: "OA07W124_2027-01-01",
            review_required_fields: ["ship_id"]
          }
        ]
      },
      source_absence_policy: {
        source_absent_candidates: [{ official_sailing_id: "ABSENT1", classification: "source_absent_candidate" }],
        source_absent_action_eligible: [{ official_sailing_id: "ABSENT2", discovered_cruise_id: "id-2" }]
      },
      production_cutoff_candidates: [{ id: "cutoff-1", official_sailing_id: "CUT1", departure_date: "2026-08-20" }]
    },
    manifest: {
      products: [
        {
          proposed_action: "insert_active",
          stable_identity_key: "INS1",
          candidate: { cruise_line_id: "line", ship_id: "ship", destination_id: "dest" }
        },
        {
          proposed_action: "update_exact_legacy_match",
          stable_identity_key: "OA07W123_2027-01-01",
          candidate: { official_url: "https://example/new" }
        }
      ]
    }
  };
}

test("weekly manifest includes all required sections", () => {
  const manifest = manifestMod.buildRoyalCaribbeanWeeklyManifestFromDryRun({
    dryRunResult: sampleDryRunResult(),
    today: "2026-08-13",
    firstActivationCycle: false
  });
  for (const key of [
    "inserts",
    "updates",
    "cutoff_hides",
    "source_absence_observations",
    "source_absence_hides",
    "review_required"
  ]) {
    if (!Array.isArray(manifest[key])) throw new Error(`missing section ${key}`);
  }
});

test("first activation cycle blocks source absence hides", () => {
  const manifest = manifestMod.buildRoyalCaribbeanWeeklyManifestFromDryRun({
    dryRunResult: sampleDryRunResult(),
    today: "2026-08-13",
    firstActivationCycle: true
  });
  if (manifest.source_absence_hides.length !== 0) {
    throw new Error("first activation cycle must force empty source_absence_hides");
  }
  const validation = manifestMod.validateFrozenWeeklyManifest(manifest, { firstActivationCycle: true });
  if (!validation.passed) throw new Error(validation.failures.join("; "));
});

test("assertWeeklyCeilings enforces 100/50/20/150 limits", () => {
  const manifest = {
    mode: manifestMod.WEEKLY_MANIFEST_MODE,
    perth_today: "2026-08-13",
    source_snapshot_id: "snap",
    inserts: Array.from({ length: 101 }, (_, i) => ({ official_sailing_id: `I${i}` })),
    updates: [],
    cutoff_hides: [],
    source_absence_hides: []
  };
  const result = manifestMod.assertWeeklyCeilings(manifest);
  if (result.ok) throw new Error("expected ceiling failure for 101 inserts");
});

test("CLI confirmation token matches weekly manifest token", () => {
  if (cli.WEEKLY_APPLY_CONFIRMATION_TOKEN !== manifestMod.WEEKLY_APPLY_CONFIRMATION_TOKEN) {
    throw new Error("confirmation token mismatch");
  }
});

test("CLI max writes capped at total ceiling", () => {
  const effective = cli.resolveEffectiveWeeklyMaxWrites(999);
  if (effective !== ROYAL_CARIBBEAN_WEEKLY_WRITE_CEILING.max_total_proposed_changes) {
    throw new Error(`expected cap ${ROYAL_CARIBBEAN_WEEKLY_WRITE_CEILING.max_total_proposed_changes}`);
  }
});

test("cruise-discovery-maintenance RC schedule remains unregistered", () => {
  const schedule = maintenance.MAINTENANCE_SCHEDULES.royal_caribbean_weekly;
  if (schedule.schedule_registered !== false) throw new Error("schedule_registered must be false until activation");
  if (schedule.cron_utc !== "0 22 * * 0") throw new Error("expected Sunday 22:00 UTC cron");
});

test("netlify.toml documents RC cron schedule for post-activation enablement", () => {
  const toml = fs.readFileSync(path.join(root, "netlify.toml"), "utf8");
  const cronBlock =
    toml.match(/\[functions\."royal-caribbean-weekly-maintenance-cron"\][\s\S]*?(?=\n\[|$)/)?.[0] || "";
  if (!/0 22 \* \* 0/.test(cronBlock)) throw new Error("cron schedule must be documented in netlify.toml");
  if (/^\s*schedule\s*=\s*"0 22 \* \* 0"/m.test(cronBlock)) {
    throw new Error("schedule must remain commented/disabled until ACTIVATION_ENABLE_SCHEDULE");
  }
});

test("prompt10 activation script documents ACTIVATION_ENABLE_SCHEDULE", () => {
  const src = fs.readFileSync(path.join(root, "scripts/run-royal-caribbean-prompt10-activation.mjs"), "utf8");
  if (!src.includes("ACTIVATION_ENABLE_SCHEDULE")) throw new Error("missing ACTIVATION_ENABLE_SCHEDULE flag");
});

test("weekly maintenance module supports frozen manifest apply path", () => {
  const src = fs.readFileSync(path.join(root, "netlify/functions/lib/royal-caribbean-weekly-maintenance.js"), "utf8");
  if (src.includes("royal_caribbean_writes_disabled")) throw new Error("hard write block must be removed");
  if (!src.includes("applyRoyalCaribbeanWeeklyManifest")) throw new Error("weekly apply import missing");
});

console.log(JSON.stringify({ passed, failed }, null, 2));
process.exit(failed > 0 ? 1 : 0);
