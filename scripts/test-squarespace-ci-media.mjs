/**
 * Offline fixture tests for Sprint 16E Squarespace → Media Library migration.
 * All network I/O is mocked. No Supabase / no real fetches.
 */

import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { assertSafeRemoteUrl, classifyHost, isPrivateOrLocalHost } from "./lib/squarespace-ci-media/url-safety.js";
import {
  sniffMime,
  sha256Hex,
  buildLineStoragePath,
  buildShipStoragePath,
  LIMITS
} from "./lib/squarespace-ci-media/media-utils.js";
import {
  collectCandidates,
  indexMediaLibrary,
  inspectAsset,
  summariseInspection
} from "./lib/squarespace-ci-media/plan.js";
import {
  runCopy,
  runDryRun,
  runPromote,
  runRollback
} from "./lib/squarespace-ci-media/migrate-core.js";
import { fetchRemoteAsset } from "./lib/squarespace-ci-media/fetch-asset.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, "../tmp/squarespace-migration-fixtures");
mkdirSync(fixtureDir, { recursive: true });

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGfAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//Z",
  "base64"
);

const SUPABASE = "https://example.supabase.co";
const SQSP_LOGO =
  "https://images.squarespace-cdn.com/content/v1/abc/logo.png";
const SQSP_HERO =
  "https://images.squarespace-cdn.com/content/v1/abc/hero.jpg";
const SQSP_DUP =
  "https://images.squarespace-cdn.com/content/v1/abc/logo-copy.png";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function mockFetchMap(map) {
  return async (url, init = {}) => {
    const key = String(url);
    const entry = map[key];
    if (!entry) {
      return {
        ok: false,
        status: 404,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(0)
      };
    }
    if (entry.redirect) {
      return {
        ok: false,
        status: entry.status || 302,
        headers: { get: (h) => (h.toLowerCase() === "location" ? entry.redirect : null) },
        arrayBuffer: async () => new ArrayBuffer(0)
      };
    }
    const buf = entry.buffer || TINY_PNG;
    return {
      ok: entry.status ? entry.status >= 200 && entry.status < 300 : true,
      status: entry.status || 200,
      headers: {
        get: (h) => {
          if (h.toLowerCase() === "content-type") return entry.contentType || "image/png";
          if (h.toLowerCase() === "content-length") return String(buf.length);
          return null;
        }
      },
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    };
  };
}

async function main() {
  let passed = 0;

  // --- URL safety ---
  assert(classifyHost(SQSP_LOGO) === "squarespace", "classify squarespace");
  passed += 1;
  assert(isPrivateOrLocalHost("127.0.0.1"), "block loopback");
  passed += 1;
  let blocked = false;
  try {
    assertSafeRemoteUrl("http://127.0.0.1/x.png");
  } catch (e) {
    blocked = e.code === "ssrf_blocked";
  }
  assert(blocked, "ssrf blocks localhost");
  passed += 1;

  // --- MIME sniff ---
  assert(sniffMime(TINY_PNG) === "image/png", "png sniff");
  passed += 1;
  assert(sniffMime(Buffer.from("not-an-image")) === null, "reject garbage");
  passed += 1;

  // --- Paths ---
  const hash = sha256Hex(TINY_PNG);
  assert(
    buildLineStoragePath("line-1", hash, "Logo.PNG").startsWith("lines/line-1/"),
    "line path"
  );
  passed += 1;
  assert(
    buildShipStoragePath("ship-1", hash, "hero.jpg").startsWith("ships/ship-1/"),
    "ship path"
  );
  passed += 1;

  const lines = [
    {
      id: "line-1",
      name: "Princess Cruises",
      logo_url: SQSP_LOGO,
      hero_image_url: null
    },
    {
      id: "line-2",
      name: "Other",
      logo_url: "https://example.supabase.co/storage/v1/object/public/cruise-media/lines/x/a.png",
      hero_image_url: null
    }
  ];
  const ships = [
    {
      id: "ship-1",
      name: "Discovery Princess",
      cruise_line_id: "line-1",
      hero_image_url: SQSP_HERO
    },
    {
      id: "ship-2",
      name: "Royal Princess",
      cruise_line_id: "line-1",
      hero_image_url: null
    }
  ];

  // --- Scope: one line ---
  const oneLine = collectCandidates(lines, ships, { lineId: "line-1" });
  assert(oneLine.length === 2, "one-line scope includes logo+hero");
  passed += 1;

  // --- Scope: logos only ---
  const logosOnly = collectCandidates(lines, ships, { logosOnly: true, lineId: "line-1" });
  assert(logosOnly.length === 1 && logosOnly[0].field === "logo_url", "logos-only");
  passed += 1;

  // --- Scope: ships only ---
  const shipsOnly = collectCandidates(lines, ships, { shipsOnly: true, lineId: "line-1" });
  assert(shipsOnly.length === 1 && shipsOnly[0].field === "hero_image_url", "ships-only");
  passed += 1;

  // --- Dry-run with mocked network ---
  const fetchMap = {
    [SQSP_LOGO]: { buffer: TINY_PNG },
    [SQSP_HERO]: { buffer: TINY_JPEG },
    [SQSP_DUP]: { buffer: TINY_PNG },
    "https://images.squarespace-cdn.com/content/v1/abc/broken.png": { status: 404 },
    "https://images.squarespace-cdn.com/content/v1/abc/redir.png": {
      redirect: "https://images.squarespace-cdn.com/content/v1/abc/logo.png",
      status: 302
    },
    "https://images.squarespace-cdn.com/content/v1/abc/evil.txt": {
      buffer: Buffer.from("not image data at all!!!!")
    },
    "http://127.0.0.1/secret.png": { buffer: TINY_PNG }
  };
  const fetchImpl = mockFetchMap(fetchMap);

  const candidates = [
    ...collectCandidates(lines, ships, { lineId: "line-1" }),
    {
      entity_type: "cruise_line",
      entity_id: "line-broken",
      entity_name: "Broken",
      cruise_line_id: "line-broken",
      ship_id: null,
      field: "logo_url",
      original_url: "https://images.squarespace-cdn.com/content/v1/abc/broken.png",
      host_class: "squarespace",
      is_selected_canonical: true,
      media_type: "cruise_line"
    },
    {
      entity_type: "cruise_line",
      entity_id: "line-redir",
      entity_name: "Redirect",
      cruise_line_id: "line-redir",
      ship_id: null,
      field: "logo_url",
      original_url: "https://images.squarespace-cdn.com/content/v1/abc/redir.png",
      host_class: "squarespace",
      is_selected_canonical: true,
      media_type: "cruise_line"
    },
    {
      entity_type: "cruise_line",
      entity_id: "line-badmime",
      entity_name: "BadMime",
      cruise_line_id: "line-badmime",
      ship_id: null,
      field: "logo_url",
      original_url: "https://images.squarespace-cdn.com/content/v1/abc/evil.txt",
      host_class: "squarespace",
      is_selected_canonical: true,
      media_type: "cruise_line"
    },
    {
      entity_type: "cruise_line",
      entity_id: "line-dup",
      entity_name: "DupUrl",
      cruise_line_id: "line-dup",
      ship_id: null,
      field: "logo_url",
      original_url: SQSP_DUP,
      host_class: "squarespace",
      is_selected_canonical: true,
      media_type: "cruise_line"
    }
  ];

  const mediaIndex = indexMediaLibrary([]);
  const inspected = await runDryRun(candidates, {
    fetchAsset: (url) => fetchRemoteAsset(url, { fetchImpl }),
    inspectAsset,
    supabaseUrl: SUPABASE,
    mediaIndex
  });

  const byId = Object.fromEntries(inspected.map((i) => [i.entity_id, i]));
  assert(byId["line-1"].status === "proposed_upload", "valid logo proposed");
  passed += 1;
  assert(byId["ship-1"].status === "proposed_upload", "valid hero proposed");
  passed += 1;
  assert(byId["line-broken"].status === "broken_url", "broken url");
  passed += 1;
  assert(byId["line-redir"].status === "proposed_upload", "redirect followed safely");
  passed += 1;
  assert(byId["line-badmime"].status === "invalid_mime", "invalid mime");
  passed += 1;

  // Duplicate binary under different URLs → same hash
  assert(
    byId["line-1"].content_hash === byId["line-dup"].content_hash,
    "duplicate binary same hash"
  );
  passed += 1;

  const summary = summariseInspection(inspected);
  assert(summary.broken_urls >= 1, "summary broken");
  passed += 1;
  assert(summary.invalid_mime_types >= 1, "summary invalid mime");
  passed += 1;
  assert(summary.proposed_uploads >= 2, "summary proposed");
  passed += 1;

  // --- Already migrated ---
  const existingMedia = [
    {
      id: "media-1",
      cruise_line_id: "line-1",
      ship_id: null,
      content_hash: byId["line-1"].content_hash,
      public_url: byId["line-1"].proposed_public_url,
      storage_path: byId["line-1"].storage_path,
      source_url: SQSP_LOGO
    }
  ];
  const again = inspectAsset(candidates[0], TINY_PNG, {
    supabaseUrl: SUPABASE,
    mediaIndex: indexMediaLibrary(existingMedia)
  });
  assert(again.status === "already_copied", "already migrated");
  passed += 1;

  // --- Copy phase leaves CI URL unchanged ---
  const uploads = [];
  const inserts = [];
  const ciPatches = [];
  const store = new Map();

  const copyItems = inspected
    .filter((i) => i.status === "proposed_upload" && (i.entity_id === "line-1" || i.entity_id === "ship-1"))
    .map((i) => ({
      ...i,
      _buffer: i.entity_id === "ship-1" ? TINY_JPEG : TINY_PNG
    }));

  const copyResults = await runCopy(copyItems, {
    uploadObject: async ({ path, buffer }) => {
      uploads.push(path);
      store.set(path, buffer);
    },
    insertMedia: async (row) => {
      const id = `ml-${inserts.length + 1}`;
      const inserted = { ...row, id };
      inserts.push(inserted);
      return inserted;
    },
    findMediaByHash: async () => null,
    verifyPublicUrl: async () => true
  });

  assert(copyResults.every((r) => r.ci_url_changed === false), "copy leaves CI unchanged");
  passed += 1;
  assert(uploads.length === 2, "two uploads");
  passed += 1;
  assert(inserts.length === 2, "two media rows");
  passed += 1;

  // --- Promote phase ---
  const { results: promoteResults, manifest } = await runPromote(
    copyResults.map((r) => ({
      ...r,
      media_library_id: r.media_library_id,
      status: "copied"
    })),
    {
      patchCiField: async (patch) => {
        ciPatches.push(patch);
      }
    }
  );
  assert(promoteResults.every((r) => r.promote_result === "promoted"), "promote ok");
  passed += 1;
  assert(ciPatches.length === 2, "two CI patches");
  passed += 1;
  assert(manifest.length === 2, "rollback manifest size");
  passed += 1;
  assert(
    ciPatches[0].new_url.includes("/storage/v1/object/public/cruise-media/"),
    "promotes to supabase url"
  );
  passed += 1;

  // --- Failed validation prevents promotion ---
  const failedPromote = await runPromote(
    [
      {
        ...copyResults[0],
        status: "proposed_upload",
        copy_result: "failed_verify",
        media_library_id: null
      }
    ],
    { patchCiField: async () => {
      throw new Error("should not patch");
    } }
  );
  assert(
    failedPromote.results[0].promote_result === "skipped_not_verified",
    "failed validation blocks promote"
  );
  passed += 1;

  // --- Rollback restores original ---
  const restored = [];
  await runRollback(manifest, {
    patchCiField: async ({ table, id, field, value }) => {
      restored.push({ table, id, field, value });
    }
  });
  assert(restored.length === 2, "rollback patches");
  passed += 1;
  assert(restored[0].value === SQSP_LOGO || restored[1].value === SQSP_LOGO, "restores squarespace");
  passed += 1;
  assert(
    restored.some((r) => r.value === SQSP_HERO),
    "restores hero url"
  );
  passed += 1;

  // --- Idempotent second copy ---
  const mediaAfter = indexMediaLibrary(
    inserts.map((r) => ({
      id: r.id,
      cruise_line_id: r.cruise_line_id,
      ship_id: r.ship_id,
      content_hash: r.content_hash,
      public_url: r.public_url,
      storage_path: r.storage_path,
      source_url: r.source_url
    }))
  );
  const secondInspect = copyItems.map((item) =>
    inspectAsset(
      {
        entity_type: item.entity_type,
        entity_id: item.entity_id,
        entity_name: item.entity_name,
        cruise_line_id: item.cruise_line_id,
        ship_id: item.ship_id,
        field: item.field,
        original_url: item.original_url,
        host_class: "squarespace",
        is_selected_canonical: true,
        media_type: item.media_type
      },
      item._buffer,
      { supabaseUrl: SUPABASE, mediaIndex: mediaAfter }
    )
  );
  assert(secondInspect.every((i) => i.status === "already_copied"), "idempotent already_copied");
  passed += 1;

  const secondCopy = await runCopy(
    secondInspect.map((i) => ({ ...i, _buffer: TINY_PNG })),
    {
      uploadObject: async () => {
        throw new Error("should not upload again");
      },
      insertMedia: async () => {
        throw new Error("should not insert again");
      },
      findMediaByHash: async () => null,
      verifyPublicUrl: async () => true
    }
  );
  assert(
    secondCopy.every((r) => r.copy_result === "skipped_already_present"),
    "zero duplicate uploads"
  );
  passed += 1;

  // --- Oversized flag ---
  const big = Buffer.alloc(LIMITS.oversizedWarnBytes + 10, 1);
  // Pretend it's PNG header so sniff fails → use real png prefix
  TINY_PNG.copy(big, 0);
  const oversizedItem = inspectAsset(
    {
      entity_type: "ship",
      entity_id: "ship-big",
      entity_name: "Big",
      cruise_line_id: "line-1",
      ship_id: "ship-big",
      field: "hero_image_url",
      original_url: SQSP_HERO,
      host_class: "squarespace",
      is_selected_canonical: true,
      media_type: "ship"
    },
    big,
    { supabaseUrl: SUPABASE, mediaIndex: indexMediaLibrary([]) }
  );
  assert(oversizedItem.oversized === true, "oversized flagged");
  passed += 1;

  const reportPath = join(fixtureDir, "fixture-report.json");
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        passed,
        dry_run_summary: summary,
        copy_uploads: uploads.length,
        promote_patches: ciPatches.length,
        rollback_restored: restored.length,
        oversized_example_bytes: oversizedItem.bytes
      },
      null,
      2
    )
  );

  console.log(`PASS ${passed} Sprint 16E Squarespace migration fixture tests`);
  console.log(`Report: ${reportPath}`);
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
