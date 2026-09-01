#!/usr/bin/env node
/**
 * Princess official-ID remap must preserve UUID and never duplicate a voyage.
 *   node scripts/test-princess-official-id-remap.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const remap = require(path.join(root, "netlify/functions/lib/princess-official-id-remap"));
const runner = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-runner"));
const toml = fs.readFileSync(path.join(root, "netlify.toml"), "utf8");
const runnerSrc = fs.readFileSync(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-runner.js"),
  "utf8"
);

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const existing = {
  id: "58c8ca14-8bbf-41e8-88b2-0e0b13284e7c",
  ship_id: "ship-gp",
  departure_date: "2026-09-26",
  return_date: "2026-10-03",
  nights: 7,
  departure_port: "Fort Lauderdale",
  destination_id: "dest-caribbean",
  official_sailing_id: "CFR07V|GP|2026-09-26",
  status: "active"
};

test("operational match with different official ID is OFFICIAL_ID_REMAP", () => {
  const result = remap.classifyPrincessProposedInsert(
    {
      official_sailing_id: "CFF07J|GP|2026-09-26",
      ship_id: existing.ship_id,
      departure_date: existing.departure_date,
      return_date: existing.return_date,
      nights: existing.nights,
      departure_port: existing.departure_port,
      destination_id: existing.destination_id
    },
    [existing]
  );
  if (result.classification !== "OFFICIAL_ID_REMAP") throw new Error(result.classification);
  if (result.existing_uuid !== existing.id) throw new Error("must keep UUID");
});

test("no operational match is TRUE_NEW", () => {
  const result = remap.classifyPrincessProposedInsert(
    {
      official_sailing_id: "CPR08C|YP|2026-11-29",
      ship_id: "ship-yp",
      departure_date: "2026-11-29",
      return_date: "2026-12-07",
      nights: 8,
      departure_port: "Port Canaveral",
      destination_id: "dest-caribbean"
    },
    [existing]
  );
  if (result.classification !== "TRUE_NEW") throw new Error(result.classification);
});

test("two operational matches are AMBIGUOUS", () => {
  const result = remap.classifyPrincessProposedInsert(
    {
      official_sailing_id: "CFF07J|GP|2026-09-26",
      ship_id: existing.ship_id,
      departure_date: existing.departure_date,
      return_date: existing.return_date,
      nights: existing.nights,
      departure_port: existing.departure_port,
      destination_id: existing.destination_id
    },
    [existing, { ...existing, id: "other" }]
  );
  if (result.classification !== "AMBIGUOUS") throw new Error(result.classification);
});

test("remap patch preserves protected operational fields and changes identity only", () => {
  const patch = remap.buildPrincessRemapPatch({
    existingRow: {
      ...existing,
      official_url: "https://www.princess.com/old",
      raw_extract: { princess_sailing_id: existing.official_sailing_id },
      itinerary: "old label"
    },
    nextOfficialSailingId: "CFF07J|GP|2026-09-26",
    nextOfficialUrl: "https://www.princess.com/new",
    nextItinerary: "Eastern Caribbean with Puerto  Rico",
    cruiseLineId: "c19f40a7-c160-4035-a845-14dada550e1f",
    runId: "test"
  });
  if (patch.official_sailing_id !== "CFF07J|GP|2026-09-26") throw new Error("official id");
  if (patch.ship_id || patch.status || patch.departure_date) throw new Error("must not patch protected fields");
  if (!patch.external_key || !patch.identity_key) throw new Error("missing identity hashes");
  if (patch.external_key === existing.external_key) throw new Error("external key must change");
  const check = remap.assertProtectedFieldsUnchanged(existing, { ...existing, ...patch });
  if (!check.ok) throw new Error(`protected changed: ${check.field}`);
});

test("frozen write set rejects missing remap identities instead of inserting them", () => {
  const frozen = runner.freezeWriteProducts({
    writeProducts: [
      { raw: { official: "TRUE_NEW_A" } },
      { raw: { official: "REMAP_SHOULD_NOT_INSERT" } },
      { raw: { official: "SAFE_UPDATE" } }
    ],
    frozenIds: new Set(["TRUE_NEW_A", "SAFE_UPDATE"]),
    keyFn: (raw) => raw.official
  });
  if (!frozen.ok) throw new Error("expected match");
  if (frozen.writeProducts.length !== 2) throw new Error("unexpected size");
  if (frozen.writeProducts.some((row) => row.raw.official === "REMAP_SHOULD_NOT_INSERT")) {
    throw new Error("remap leaked into frozen writes");
  }
  const mismatch = runner.freezeWriteProducts({
    writeProducts: [{ raw: { official: "TRUE_NEW_A" } }],
    frozenIds: new Set(["TRUE_NEW_A", "MISSING"]),
    keyFn: (raw) => raw.official
  });
  if (mismatch.ok || mismatch.reason !== "frozen_manifest_identity_mismatch") {
    throw new Error("mismatch must fail closed");
  }
});

test("Celebrity and HAL weekly runners honour frozenOfficialSailingIds", () => {
  if (!runnerSrc.includes("frozenOfficialSailingIds") || !runnerSrc.includes("freezeWriteProducts")) {
    throw new Error("missing freeze helper usage");
  }
  const celebrityIdx = runnerSrc.indexOf("async function runCelebrityWeeklyMaintenance");
  const princessIdx = runnerSrc.indexOf("async function runPrincessWeeklyMaintenance");
  const celebrityBlock = runnerSrc.slice(celebrityIdx, princessIdx);
  if (!celebrityBlock.includes("frozenOfficialSailingIds")) throw new Error("celebrity missing freeze");
  const halIdx = runnerSrc.indexOf("async function runHalWeeklyMaintenance");
  const halBlock = runnerSrc.slice(halIdx, celebrityIdx);
  if (!halBlock.includes("frozenOfficialSailingIds")) throw new Error("hal missing freeze");
});

test("Princess Netlify cron remains unscheduled", () => {
  const block = toml.match(/\[functions\."princess-weekly-maintenance-cron"\][\s\S]*?(?=\n\[|$)/)?.[0] || "";
  if (/schedule\s*=/.test(block)) throw new Error("Princess Netlify schedule must stay removed");
});

test("Celebrity/HAL background packaging includes ports catalogue", () => {
  for (const name of ["celebrity-weekly-maintenance-background", "hal-weekly-maintenance-background"]) {
    const block = toml.match(new RegExp(`\\[functions\\."${name}"\\][\\s\\S]*?(?=\\n\\[|$)`))?.[0] || "";
    if (!block.includes("data/ports/ports-catalogue.csv")) throw new Error(`${name} missing ports-catalogue`);
  }
});

console.log(`\n${passed} passed`);
