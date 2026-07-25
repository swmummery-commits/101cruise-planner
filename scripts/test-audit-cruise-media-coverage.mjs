/**
 * Offline tests for Cruise Media Coverage Audit.
 * No network. No credentials. No live DB writes.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUDIT_ALLOWED_HTTP_METHODS,
  AUDIT_FORBIDDEN_HTTP_METHODS,
  AUDIT_FORBIDDEN_EXPORT_NAMES,
  assertAuditHttpMethod
} from "./lib/media-coverage-audit/read-only.js";
import * as readOnly from "./lib/media-coverage-audit/read-only.js";
import * as analyze from "./lib/media-coverage-audit/analyze.js";
import {
  analyseCruiseLine,
  analyseShip,
  mediaStatusFromUrl,
  pickMatchingMedia,
  collectCatalogueAnomalies,
  summariseCoverage,
  sharedBinaryGroups,
  indexContentHashes
} from "./lib/media-coverage-audit/analyze.js";
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

async function main() {
  let passed = 0;

  // HTTP surface: GET/HEAD only
  assert(AUDIT_ALLOWED_HTTP_METHODS.join() === "GET,HEAD", "allowed methods");
  assert(AUDIT_FORBIDDEN_HTTP_METHODS.includes("POST"), "forbid POST");
  assert(AUDIT_FORBIDDEN_HTTP_METHODS.includes("PATCH"), "forbid PATCH");
  assert(AUDIT_FORBIDDEN_HTTP_METHODS.includes("DELETE"), "forbid DELETE");
  assert(AUDIT_FORBIDDEN_HTTP_METHODS.includes("PUT"), "forbid PUT");
  assertAuditHttpMethod("GET");
  assertAuditHttpMethod("HEAD");
  assertThrows(() => assertAuditHttpMethod("POST"), "audit_write_forbidden");
  assertThrows(() => assertAuditHttpMethod("PATCH"), "audit_write_forbidden");
  assertThrows(() => assertAuditHttpMethod("DELETE"), "audit_write_forbidden");
  passed += 1;

  // read-only module exposes no write helpers
  for (const name of AUDIT_FORBIDDEN_EXPORT_NAMES) {
    assert(readOnly[name] === undefined, `read-only must not export ${name}`);
    assert(analyze[name] === undefined, `analyze must not export ${name}`);
  }
  passed += 1;

  // CLI source must not contain write verbs against Supabase/Storage
  const cliPath = path.join(__dirname, "audit-cruise-media-coverage.mjs");
  const cliSrc = fs.readFileSync(cliPath, "utf8");
  assert(!/\bmethod:\s*["']POST["']/.test(cliSrc), "no POST in CLI");
  assert(!/\bmethod:\s*["']PATCH["']/.test(cliSrc), "no PATCH in CLI");
  assert(!/\bmethod:\s*["']PUT["']/.test(cliSrc), "no PUT in CLI");
  assert(!/\bmethod:\s*["']DELETE["']/.test(cliSrc), "no DELETE in CLI");
  assert(!/uploadObject|insertMedia|x-upsert/.test(cliSrc), "no upload helpers");
  assert(/assertAuditHttpMethod/.test(cliSrc), "uses HTTP guard");
  assert(/READ-ONLY|read-only/.test(cliSrc), "documents read-only");
  passed += 1;

  // target gate before network
  assert(parseTargetArg(["node", "x"]) === null, "missing target");
  assert(parseTargetArg(["node", "x", "--target=dev"]) === "dev", "dev parse");
  assert(
    parseTargetArg(["node", "x", "--target=production"]) === "production",
    "prod parse"
  );
  passed += 1;

  // status classification
  assert(mediaStatusFromUrl("") === "missing", "missing");
  assert(
    mediaStatusFromUrl("https://images.squarespace-cdn.com/x.png") === "squarespace",
    "sq"
  );
  assert(
    mediaStatusFromUrl(
      "https://xikbibxyinttllxamgao.supabase.co/storage/v1/object/public/cruise-media/x.png"
    ) === "supabase",
    "sb"
  );
  assert(mediaStatusFromUrl("https://cdn.example.com/a.jpg") === "other_external", "ext");
  passed += 1;

  // matching + relationship
  const logoUrl =
    "https://xikbibxyinttllxamgao.supabase.co/storage/v1/object/public/cruise-media/lines/L1/logo.png";
  const heroUrl =
    "https://xikbibxyinttllxamgao.supabase.co/storage/v1/object/public/cruise-media/ships/S1/hero.png";
  const media = [
    {
      id: "m1",
      cruise_line_id: "L1",
      ship_id: null,
      public_url: logoUrl,
      source_url: "https://images.squarespace-cdn.com/logo.png",
      content_hash: "abc",
      storage_path: "lines/L1/abc-logo.png"
    },
    {
      id: "m2",
      cruise_line_id: "L1",
      ship_id: "S1",
      public_url: heroUrl,
      content_hash: "def",
      storage_path: "ships/S1/def-hero.png"
    },
    {
      id: "m3",
      cruise_line_id: "L1",
      ship_id: null,
      public_url: logoUrl.replace("logo.png", "logo-old.png"),
      content_hash: "abc",
      storage_path: "lines/L1/abc-old.png"
    }
  ];
  assert(pickMatchingMedia([media[0]], logoUrl)?.id === "m1", "exact match");
  const lineRow = analyseCruiseLine({
    line: { id: "L1", name: "Line One", logo_url: logoUrl, active: true },
    mediaRows: media,
    reachable: true
  });
  assert(lineRow.logo_status === "supabase", "line supabase");
  assert(lineRow.matching_media_library === "yes", "line match");
  assert(lineRow.duplicate_media_library_records === 2, "dup line media");
  assert(lineRow.anomalies.includes("duplicate_media_library_rows"), "dup anomaly");

  const shipRow = analyseShip({
    ship: {
      id: "S1",
      name: "Ship One",
      cruise_line_id: "L1",
      hero_image_url: heroUrl,
      active: true
    },
    lineName: "Line One",
    mediaRows: media,
    reachable: true
  });
  assert(shipRow.hero_status === "supabase", "ship supabase");
  assert(shipRow.matching_media_library === "yes", "ship match");
  assert(shipRow.relationship_correct === "yes", "rel ok");
  passed += 1;

  // missing / broken / squarespace
  const missing = analyseCruiseLine({
    line: { id: "L2", name: "Bare", logo_url: null, active: true },
    mediaRows: [],
    reachable: null
  });
  assert(missing.logo_status === "missing", "missing logo");
  assert(missing.url_reachable === "not_applicable", "n/a");

  const sq = analyseShip({
    ship: {
      id: "S2",
      name: "Sq Ship",
      cruise_line_id: "L1",
      hero_image_url: "https://images.squarespace-cdn.com/h.jpg"
    },
    lineName: "Line One",
    mediaRows: [],
    reachable: false
  });
  assert(sq.hero_status === "squarespace", "sq hero");
  assert(sq.anomalies.includes("broken_url"), "broken");
  assert(sq.anomalies.includes("remaining_squarespace_url"), "sq remain");
  passed += 1;

  // incorrect relationship + orphans + shared binary review
  const badMedia = [
    {
      id: "mx",
      cruise_line_id: "WRONG",
      ship_id: "S1",
      public_url: heroUrl,
      content_hash: "shared1"
    },
    {
      id: "my",
      cruise_line_id: "L9",
      ship_id: null,
      public_url:
        "https://xikbibxyinttllxamgao.supabase.co/storage/v1/object/public/cruise-media/other.png",
      content_hash: "shared1"
    },
    {
      id: "mz",
      cruise_line_id: "MISSING-LINE",
      ship_id: null,
      public_url:
        "https://xikbibxyinttllxamgao.supabase.co/storage/v1/object/public/cruise-media/z.png",
      content_hash: "zzz"
    }
  ];
  const shared = sharedBinaryGroups(indexContentHashes(badMedia));
  assert(shared.length === 1, "shared group");
  const cats = collectCatalogueAnomalies({
    lines: [{ id: "L1", name: "Line One" }],
    ships: [{ id: "S1", cruise_line_id: "L1", name: "Ship One" }],
    mediaRows: badMedia,
    lineRows: [missing],
    shipRows: [sq],
    sharedBinaries: shared,
    storageOrphans: [
      { media_library_id: "mx", detail: "missing object" }
    ]
  });
  assert(
    cats.some((a) => a.category === "orphan_media_library_line"),
    "orphan line"
  );
  assert(
    cats.some((a) => a.category === "incorrect_media_relationship"),
    "bad rel"
  );
  assert(cats.some((a) => a.category === "shared_binary_review"), "shared review");
  assert(
    cats.some((a) => a.category === "orphaned_storage_reference"),
    "storage orphan"
  );
  passed += 1;

  const summary = summariseCoverage({
    lineRows: [lineRow, missing],
    shipRows: [shipRow, sq],
    anomalies: cats,
    sharedBinaries: shared
  });
  assert(summary.total_cruise_lines === 2, "2 lines");
  assert(summary.lines_with_missing_logos === 1, "1 missing logo");
  assert(summary.remaining_squarespace_urls === 1, "1 sq");
  assert(summary.writes.insert === 0, "no insert");
  assert(summary.writes.update === 0, "no update");
  assert(summary.writes.delete === 0, "no delete");
  assert(summary.writes.storage_writes === 0, "no storage write");
  assert(summary.writes.dev_writes === 0, "no dev write");
  passed += 1;

  console.log(`PASS ${passed} cruise media coverage audit tests`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
