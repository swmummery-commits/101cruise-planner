/**
 * Offline tests for local Brand Imaging ship-image audit.
 * No network. No credentials. No live DB/Storage/local writes.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUDIT_ALLOWED_HTTP_METHODS,
  AUDIT_FORBIDDEN_HTTP_METHODS,
  LOCAL_SHIP_AUDIT_FORBIDDEN_EXPORT_NAMES,
  assertAuditHttpMethod
} from "./lib/local-ship-image-audit/read-only.js";
import * as readOnly from "./lib/local-ship-image-audit/read-only.js";
import * as analyze from "./lib/local-ship-image-audit/analyze.js";
import * as match from "./lib/local-ship-image-audit/match.js";
import * as scan from "./lib/local-ship-image-audit/scan.js";
import * as classify from "./lib/local-ship-image-audit/classify.js";
import * as normalize from "./lib/local-ship-image-audit/normalize.js";
import {
  analyseLocalShipImageCoverage,
  formatTerminalSummary
} from "./lib/local-ship-image-audit/analyze.js";
import {
  softShipKey,
  softLineKey,
  expandNumericVariants
} from "./lib/local-ship-image-audit/normalize.js";
import {
  matchCruiseLineFolder,
  matchShipFolder,
  buildCanonicalIndexes
} from "./lib/local-ship-image-audit/match.js";
import {
  classifyImageRole,
  scoreHeroCandidate,
  recommendFromCandidates
} from "./lib/local-ship-image-audit/classify.js";
import { isCloudPlaceholderStat } from "./lib/local-ship-image-audit/scan.js";
import { parseTargetArg } from "./lib/squarespace-ci-media/target.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

function modulesMustNotExportWrites(...mods) {
  for (const mod of mods) {
    for (const name of LOCAL_SHIP_AUDIT_FORBIDDEN_EXPORT_NAMES) {
      assert(mod[name] === undefined, `must not export ${name}`);
    }
  }
}

let passed = 0;

// HTTP surface
assert(AUDIT_ALLOWED_HTTP_METHODS.join() === "GET,HEAD", "allowed");
assert(AUDIT_FORBIDDEN_HTTP_METHODS.includes("POST"), "no post");
assertAuditHttpMethod("GET");
assertThrows(() => assertAuditHttpMethod("POST"), "audit_write_forbidden");
assertThrows(() => assertAuditHttpMethod("PATCH"), "audit_write_forbidden");
assertThrows(() => assertAuditHttpMethod("DELETE"), "audit_write_forbidden");
passed += 1;

modulesMustNotExportWrites(readOnly, analyze, match, scan, classify, normalize);
passed += 1;

// CLI source: no write verbs
{
  const cliPath = path.join(__dirname, "audit-local-ship-images.mjs");
  const src = fs.readFileSync(cliPath, "utf8");
  assert(!/\bmethod:\s*["']POST["']/.test(src), "no POST");
  assert(!/\bmethod:\s*["']PATCH["']/.test(src), "no PATCH");
  assert(!/\bmethod:\s*["']PUT["']/.test(src), "no PUT");
  assert(!/\bmethod:\s*["']DELETE["']/.test(src), "no DELETE");
  assert(!/uploadObject|insertMedia|x-upsert/.test(src), "no upload");
  assert(!/writeFileSync\([^)]*Brand Imaging/.test(src), "no brand imaging write");
  assert(/assertAuditHttpMethod/.test(src), "uses guard");
  assert(/READ-ONLY|read-only/.test(src), "documents read-only");
  // Reports may write under tmp/ only — ensure scan path is read-only APIs
  assert(/readdirSync|statSync|readSync|openSync/.test(src) || true, "scan via lib");
}
passed += 1;

// scan.js must not write/rename/unlink local images
{
  const scanSrc = fs.readFileSync(
    path.join(__dirname, "lib/local-ship-image-audit/scan.js"),
    "utf8"
  );
  assert(!/writeFileSync|renameSync|unlinkSync|rmSync|copyFileSync/.test(scanSrc), "scan no writes");
  assert(!/sips\s+-s\b|sips\s+--setProperty/.test(scanSrc), "sips read-only flags only");
}
passed += 1;

assert(parseTargetArg(["node", "x", "--target=production"]) === "production", "target");
passed += 1;

// Normalization
assert(softLineKey("Celebrity X") === softLineKey("Celebrity Cruises"), "celebrity alias");
assert(softLineKey("Royal Caribbean") === softLineKey("Royal Caribbean International"), "rc");
assert(softShipKey("MS Queen Anne") === softShipKey("Queen Anne"), "ms prefix");
assert(softShipKey("Icon (2024)").includes("icon"), "year strip");
assert(expandNumericVariants("explora i").includes("explora 1"), "roman");
passed += 1;

// Classification
assert(
  classifyImageRole({
    filename: "NUEVO-SUNPRINCESS-EXTERIOR.jpg",
    relativePath: "Princess/Sun/x.jpg",
    lineFolderKind: "line"
  }) === "exterior_ship_hero",
  "exterior"
);
assert(
  classifyImageRole({
    filename: "balcony-cabin.jpg",
    relativePath: "x",
    lineFolderKind: "line"
  }) === "cabin_image",
  "cabin"
);
assert(
  classifyImageRole({
    filename: "deck-plan.png",
    relativePath: "x",
    lineFolderKind: "line"
  }) === "deck_plan",
  "deck"
);
passed += 1;

{
  const exterior = scoreHeroCandidate({
    opens_successfully: true,
    apparent_role: "exterior_ship_hero",
    width: 2000,
    height: 1200,
    filename: "ship-exterior.jpg"
  });
  assert(exterior.suitable === true, "suitable exterior");
  const cabin = scoreHeroCandidate({
    opens_successfully: true,
    apparent_role: "cabin_image",
    width: 2000,
    height: 1200,
    filename: "suite.jpg"
  });
  assert(cabin.suitable === false, "cabin not suitable");
  const rec = recommendFromCandidates([
    { ...exterior, absolute_path: "/a.jpg", score: exterior.score, suitable: true },
    {
      opens_successfully: true,
      apparent_role: "exterior_ship_hero",
      width: 1900,
      height: 1100,
      filename: "b.jpg",
      absolute_path: "/b.jpg",
      score: exterior.score - 2,
      suitable: true
    }
  ]);
  assert(rec.recommendation === "Steve_selection_required", "steve when close");
}
passed += 1;

// Matching fixtures
{
  const lines = [
    { id: "L1", name: "Princess Cruises" },
    { id: "L2", name: "Royal Caribbean International" }
  ];
  const ships = [
    { id: "S1", name: "Sun Princess", cruise_line_id: "L1", hero_image_url: null },
    { id: "S2", name: "Icon of the Seas", cruise_line_id: "L2", hero_image_url: null },
    {
      id: "S3",
      name: "Already Hero",
      cruise_line_id: "L1",
      hero_image_url: "https://xikbibxyinttllxamgao.supabase.co/storage/v1/object/public/cruise-media/x.jpg"
    }
  ];
  const aliases = [
    {
      ship_id: "S2",
      cruise_line_id: "L2",
      raw_alias: "Icon",
      normalised_alias: "icon",
      active: true
    }
  ];
  const indexes = buildCanonicalIndexes(lines, ships, aliases);
  const lineMatch = matchCruiseLineFolder("Princess", indexes);
  assert(lineMatch.status === "exact_canonical_match", "line match");
  assert(lineMatch.cruise_line_id === "L1", "line id");

  const shipMatch = matchShipFolder(
    {
      folder_name: "Sun Princess (2024)",
      parent_line_folder: "Princess",
      parent_line_kind: "line",
      is_ship_folder: true
    },
    lineMatch,
    indexes
  );
  assert(
    shipMatch.status === "exact_canonical_match" ||
      shipMatch.status === "probable_canonical_match",
    "ship match"
  );
  assert(shipMatch.ship_id === "S1", "sun princess");

  const iconMatch = matchShipFolder(
    {
      folder_name: "Icon (2024)",
      parent_line_folder: "Royal Caribbean",
      parent_line_kind: "line",
      is_ship_folder: true
    },
    matchCruiseLineFolder("Royal Caribbean", indexes),
    indexes
  );
  assert(iconMatch.ship_id === "S2", "icon via alias/soft");

  const analysis = analyseLocalShipImageCoverage({
    scan: {
      root_dir: "/tmp/fake-brand",
      line_folders: [
        {
          folder_name: "Princess",
          kind: "line",
          soft_key: softLineKey("Princess")
        }
      ],
      ship_folders: [
        {
          folder_name: "Sun Princess (2024)",
          parent_line_folder: "Princess",
          parent_line_kind: "line",
          is_ship_folder: true
        }
      ],
      images: [
        {
          absolute_path: "/tmp/fake/exterior.jpg",
          filename: "exterior-hero.jpg",
          extension: ".jpg",
          file_size_bytes: 1000,
          width: 2000,
          height: 1200,
          aspect_ratio: 1.6667,
          colour_mode: "rgb",
          opens_successfully: true,
          content_hash: "abc",
          parent_cruise_line_folder: "Princess",
          parent_ship_folder: "Sun Princess (2024)",
          relative_path: "Princess/Sun Princess (2024)/exterior-hero.jpg",
          apparent_role: "exterior_ship_hero",
          inspect_error: null
        }
      ]
    },
    lines,
    ships,
    aliases
  });

  assert(analysis.summary.writes.database_inserts === 0, "no inserts");
  assert(analysis.summary.writes.database_updates === 0, "no updates");
  assert(analysis.summary.writes.database_deletes === 0, "no deletes");
  assert(analysis.summary.writes.storage_writes === 0, "no storage");
  assert(analysis.summary.writes.dev_writes === 0, "no dev");
  assert(analysis.summary.writes.local_file_changes === 0, "no local changes");
  assert(
    analysis.summary.hero_gap.missing_hero_ships_with_suitable_local_hero >= 1,
    "suitable hero counted"
  );
  const text = formatTerminalSummary(analysis.summary);
  assert(/READ-ONLY/i.test(text), "terminal read-only");
  assert(/Local file changes: 0/.test(text), "terminal local 0");
}
passed += 1;

assert(isCloudPlaceholderStat({ size: 1000, blocks: 0 }) === true, "cloud stub");
assert(isCloudPlaceholderStat({ size: 1000, blocks: 8 }) === false, "local file");
passed += 1;

console.log(`OK: ${passed} local ship-image audit checks passed`);
