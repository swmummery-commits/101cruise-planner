/**
 * Offline tests for approved local cruise-line logo importer.
 * No network. No credentials. No live import.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import {
  HURTIGRUTEN_LINE_ID,
  HURTIGRUTEN_LINE_NAME,
  HURTIGRUTEN_LOCAL_PATH,
  HURTIGRUTEN_CONFIRM_TOKEN,
  LOGO_KEY,
  getHurtigrutenLogoConfig,
  assertHurtigrutenCliGate,
  isForbiddenHxName
} from "./lib/approved-line-logo-import/hurtigruten.js";
import {
  getApprovedLogoConfig,
  inspectApprovedLocalLogo,
  classifyApprovedLogoPlan,
  assertExactOneInsertedRow,
  runApprovedLineLogoImport,
  emptyWriteCounts,
  isSafeOriginalCruiseMediaUrl
} from "./lib/approved-line-logo-import/import-runner.js";
import {
  resolveMigrationTarget,
  formatTargetBanner,
  PRODUCTION_REF,
  DEV_REF
} from "./lib/squarespace-ci-media/target.js";
import { buildLineStoragePath, publicMediaUrl, sha256Hex } from "./lib/squarespace-ci-media/media-utils.js";
import { assertExactOnePatchedRow } from "./lib/squarespace-ci-media/verified-ci-patch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

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

async function assertThrowsAsync(fn, code) {
  let ok = false;
  try {
    await fn();
  } catch (e) {
    ok = e.code === code;
    if (!ok) throw new Error(`expected ${code}, got ${e.code}: ${e.message}`);
  }
  assert(ok, `expected throw ${code}`);
}

/** Minimal valid RGB PNG with given dimensions (solid black). */
function makePng(width, height) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  function crc32(buf) {
    let c = ~0;
    for (let i = 0; i < buf.length; i += 1) {
      c ^= buf[i];
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
      }
    }
    return ~c >>> 0;
  }
  function makeChunk(type, data) {
    const typeBuf = Buffer.from(type, "ascii");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + width * 3, 0);
  const raw = Buffer.alloc((1 + width * 3) * height);
  for (let y = 0; y < height; y += 1) row.copy(raw, y * row.length);
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    signature,
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", idat),
    makeChunk("IEND", Buffer.alloc(0))
  ]);
}

const SUPABASE_URL = `https://${PRODUCTION_REF}.supabase.co`;
const config = getHurtigrutenLogoConfig();
const PNG_500 = makePng(500, 500);
const PNG_HASH = sha256Hex(PNG_500);
const STORAGE_PATH = buildLineStoragePath(
  HURTIGRUTEN_LINE_ID,
  PNG_HASH,
  "hurtigruten.png"
);
const PUBLIC_URL = publicMediaUrl(SUPABASE_URL, STORAGE_PATH);

function baseCli(overrides = {}) {
  return {
    target: "production",
    mode: "dry-run",
    logoKey: LOGO_KEY,
    confirmToken: HURTIGRUTEN_CONFIRM_TOKEN,
    argv: [
      "node",
      "import-approved-line-logo.mjs",
      "--dry-run",
      "--target=production",
      "--logo=hurtigruten",
      `--confirm=${HURTIGRUTEN_CONFIRM_TOKEN}`
    ],
    ...overrides
  };
}

function lineFixture(overrides = {}) {
  return {
    id: HURTIGRUTEN_LINE_ID,
    name: HURTIGRUTEN_LINE_NAME,
    logo_url: null,
    ...overrides
  };
}

function mediaFixture(overrides = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    media_type: "cruise_line",
    cruise_line_id: HURTIGRUTEN_LINE_ID,
    ship_id: null,
    public_url: PUBLIC_URL,
    storage_path: STORAGE_PATH,
    content_hash: PNG_HASH,
    import_source: "approved_local_logo",
    ...overrides
  };
}

async function runWith(deps) {
  return runApprovedLineLogoImport({
    cli: baseCli({ mode: deps.mode || "dry-run" }),
    mode: deps.mode || "dry-run",
    projectRef: PRODUCTION_REF,
    supabaseUrl: SUPABASE_URL,
    readLocalFile: async () => PNG_500,
    loadLine: async () => lineFixture(),
    loadLineMedia: async () => [],
    loadMediaByLineHash: async () => [],
    loadHxLines: async () => [],
    storageExists: async () => false,
    verifyPublicUrl: async () => true,
    writeRollbackManifest: async () => "/tmp/rollback-test.json",
    ...deps
  });
}

let passed = 0;

// --- fixed identity ---
assert(HURTIGRUTEN_LINE_ID === "297df8d9-6d36-4855-993d-e30bbfaf29e0", "fixed UUID");
assert(HURTIGRUTEN_LINE_NAME === "Hurtigruten", "fixed name");
assert(
  HURTIGRUTEN_LOCAL_PATH.endsWith("/hurtigruten.png"),
  "fixed local path ends with hurtigruten.png"
);
assert(getApprovedLogoConfig("hurtigruten").cruise_line_id === HURTIGRUTEN_LINE_ID, "registry uuid");
passed += 1;

// --- CLI gates before network ---
assertThrows(
  () =>
    assertHurtigrutenCliGate({
      target: "dev",
      mode: "dry-run",
      logoKey: LOGO_KEY,
      confirmToken: HURTIGRUTEN_CONFIRM_TOKEN,
      argv: []
    }),
  "approved_logo_target_invalid"
);
passed += 1;

assertThrows(
  () =>
    assertHurtigrutenCliGate({
      target: "production",
      mode: "dry-run",
      logoKey: "hx",
      confirmToken: HURTIGRUTEN_CONFIRM_TOKEN,
      argv: []
    }),
  "approved_logo_key_invalid"
);
passed += 1;

assertThrows(
  () =>
    assertHurtigrutenCliGate({
      target: "production",
      mode: "dry-run",
      logoKey: LOGO_KEY,
      confirmToken: "WRONG",
      argv: []
    }),
  "approved_logo_confirm_invalid"
);
passed += 1;

assertThrows(
  () =>
    assertHurtigrutenCliGate({
      ...baseCli(),
      argv: [...baseCli().argv, "--file=/tmp/evil.png"]
    }),
  "approved_logo_arbitrary_path_or_uuid"
);
passed += 1;

assertThrows(
  () =>
    assertHurtigrutenCliGate({
      ...baseCli(),
      argv: [...baseCli().argv, `--line-id=${HURTIGRUTEN_LINE_ID}`]
    }),
  "approved_logo_arbitrary_path_or_uuid"
);
passed += 1;

assertThrows(() => getApprovedLogoConfig("hx"), "approved_logo_key_invalid");
passed += 1;

assert(isForbiddenHxName("HX") === true, "hx forbidden name");
assert(isForbiddenHxName("Hurtigruten Expeditions") === true, "hx expeditions forbidden");
assert(isForbiddenHxName("Hurtigruten") === false, "hurtigruten ok");
passed += 1;

// --- target resolution ---
assertThrows(
  () =>
    resolveMigrationTarget({
      target: "dev",
      mode: "import-approved-line-logo",
      env: {
        SUPABASE_DEV_URL: `https://${DEV_REF}.supabase.co`,
        SUPABASE_DEV_SERVICE_ROLE_KEY: "x"
      }
    }),
  "approved_logo_dev_forbidden"
);
passed += 1;

const prodEnv = resolveMigrationTarget({
  target: "production",
  mode: "import-approved-line-logo",
  env: {
    SUPABASE_URL: SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: "test-key"
  }
});
assert(prodEnv.production_approved_logo_import_gated === true, "gated flag");
assert(prodEnv.writes_allowed === false, "writes not open");
const banner = formatTargetBanner(prodEnv, "import-approved-line-logo");
assert(/approved local logo import/i.test(banner), "banner mentions approved logo");
passed += 1;

// --- local file inspection ---
const inspection = inspectApprovedLocalLogo(config, PNG_500, { supabaseUrl: SUPABASE_URL });
assert(inspection.width === 500 && inspection.height === 500, "dims 500");
assert(inspection.mime_type === "image/png", "png mime");
assert(inspection.content_hash === PNG_HASH, "hash");
assert(inspection.storage_path === STORAGE_PATH, "storage path");
assert(isSafeOriginalCruiseMediaUrl(inspection.proposed_public_url, SUPABASE_URL), "url safe");
passed += 1;

assertThrows(
  () => inspectApprovedLocalLogo(config, Buffer.alloc(0), { supabaseUrl: SUPABASE_URL }),
  "approved_logo_file_empty"
);
passed += 1;

assertThrows(
  () =>
    inspectApprovedLocalLogo(config, Buffer.from("not-an-image"), {
      supabaseUrl: SUPABASE_URL
    }),
  "approved_logo_format_invalid"
);
passed += 1;

assertThrows(
  () => inspectApprovedLocalLogo(config, makePng(100, 100), { supabaseUrl: SUPABASE_URL }),
  "approved_logo_dimensions_invalid"
);
passed += 1;

assertThrows(
  () =>
    classifyApprovedLogoPlan({
      config,
      currentLogoUrl: "https://example.com/other.png",
      inspection,
      lineMediaRows: [],
      matchingHashRows: [],
      storageExists: false
    }),
  "approved_logo_conflicting_logo_url"
);
passed += 1;

assertThrows(
  () =>
    classifyApprovedLogoPlan({
      config,
      currentLogoUrl: null,
      inspection,
      lineMediaRows: [
        mediaFixture({
          id: "22222222-2222-2222-2222-222222222222",
          content_hash: "deadbeef",
          storage_path: "lines/x/other.png",
          public_url: "https://example.com/x.png"
        })
      ],
      matchingHashRows: [],
      storageExists: false
    }),
  "approved_logo_conflicting_media"
);
passed += 1;

// --- dry run zero writes ---
{
  const result = await runWith({ mode: "dry-run" });
  assert(result.wrote === false, "dry-run wrote false");
  assert(result.database_writes === 0, "dry-run db 0");
  assert(result.storage_writes === 0, "dry-run storage 0");
  assert(result.dev_writes === 0, "dry-run dev 0");
  assert(result.writes.storage_uploads === 0, "dry-run uploads 0");
  assert(result.rollback_manifest_path === null, "dry-run no rollback");
  assert(result.canonical_uuid === HURTIGRUTEN_LINE_ID, "dry-run uuid");
  assert(result.canonical_name === HURTIGRUTEN_LINE_NAME, "dry-run name");
}
passed += 1;

// --- missing file ---
await assertThrowsAsync(
  () =>
    runWith({
      mode: "dry-run",
      readLocalFile: async () => {
        throw Object.assign(new Error("missing"), { code: "approved_logo_file_missing" });
      }
    }),
  "approved_logo_file_missing"
);
passed += 1;

// --- HX cannot be modified ---
await assertThrowsAsync(
  () =>
    runWith({
      mode: "dry-run",
      loadLine: async () => ({
        id: HURTIGRUTEN_LINE_ID,
        name: "HX",
        logo_url: null
      })
    }),
  "approved_logo_line_name_mismatch"
);
passed += 1;

await assertThrowsAsync(
  () =>
    runApprovedLineLogoImport({
      cli: baseCli({ mode: "apply", logoKey: "hx" }),
      mode: "apply",
      projectRef: PRODUCTION_REF,
      supabaseUrl: SUPABASE_URL,
      readLocalFile: async () => PNG_500,
      loadLine: async () => lineFixture(),
      loadLineMedia: async () => [],
      loadMediaByLineHash: async () => [],
      loadHxLines: async () => [],
      storageExists: async () => false,
      verifyPublicUrl: async () => true,
      writeRollbackManifest: async () => "/tmp/r.json"
    }),
  "approved_logo_key_invalid"
);
passed += 1;

// --- apply: at most one upload / insert / logo_url update; rollback before write ---
{
  let rollbackBeforeUpload = false;
  let uploads = 0;
  let inserts = 0;
  let patches = 0;
  let rollbackAt = null;
  const mediaId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  const result = await runApprovedLineLogoImport({
    cli: baseCli({ mode: "apply" }),
    mode: "apply",
    projectRef: PRODUCTION_REF,
    supabaseUrl: SUPABASE_URL,
    readLocalFile: async () => PNG_500,
    loadLine: async () => lineFixture(),
    loadLineMedia: async () => [],
    loadMediaByLineHash: async () => [],
    loadHxLines: async () => [],
    storageExists: async () => uploads > 0,
    verifyPublicUrl: async () => true,
    writeRollbackManifest: async () => {
      rollbackAt = Date.now();
      return "/tmp/rollback-hurtigruten.json";
    },
    uploadObject: async () => {
      if (rollbackAt == null) rollbackBeforeUpload = false;
      else rollbackBeforeUpload = true;
      uploads += 1;
      assert(uploads <= 1, "at most one upload");
    },
    insertMedia: async (row) => {
      inserts += 1;
      assert(inserts <= 1, "at most one insert");
      assert(row.cruise_line_id === HURTIGRUTEN_LINE_ID, "insert line");
      assert(row.ship_id === null, "insert ship null");
      assert(row.import_source === "approved_local_logo", "import source");
      assert(row.source_url === null, "source null");
      return [
        {
          id: mediaId,
          ...row
        }
      ];
    },
    readMediaById: async (id) => ({
      id,
      media_type: "cruise_line",
      cruise_line_id: HURTIGRUTEN_LINE_ID,
      ship_id: null,
      public_url: PUBLIC_URL,
      content_hash: PNG_HASH,
      storage_path: STORAGE_PATH
    }),
    patchLineLogo: async ({ table, id, field, value }) => {
      patches += 1;
      assert(patches <= 1, "at most one patch");
      assert(table === "ci_cruise_lines", "table");
      assert(id === HURTIGRUTEN_LINE_ID, "only hurtigruten");
      assert(field === "logo_url", "only logo_url");
      assert(value === PUBLIC_URL, "patch value");
      return {
        status: 200,
        body: [{ id, logo_url: value }]
      };
    },
    readLineField: async ({ id, field }) => ({
      id,
      [field]: PUBLIC_URL
    }),
    countOtherLineChanges: async () => 0
  });

  assert(rollbackBeforeUpload === true, "rollback manifest before write");
  assert(result.writes.storage_uploads === 1, "one upload counted");
  assert(result.writes.media_library_inserts === 1, "one insert counted");
  assert(result.writes.cruise_line_updates === 1, "one line update");
  assert(result.writes.database_deletes === 0, "no db deletes");
  assert(result.writes.storage_deletes === 0, "no storage deletes");
  assert(result.dev_writes === 0, "dev zero");
  assert(result.strategy === "verified_sequential_import_with_rollback_evidence", "strategy");
}
passed += 1;

// --- verified insert enforcement ---
assertThrows(
  () =>
    assertExactOneInsertedRow([], {
      cruiseLineId: HURTIGRUTEN_LINE_ID,
      contentHash: PNG_HASH,
      publicUrl: PUBLIC_URL
    }),
  "insert_zero_rows"
);
assertThrows(
  () =>
    assertExactOneInsertedRow(
      [
        mediaFixture(),
        mediaFixture({ id: "33333333-3333-3333-3333-333333333333" })
      ],
      {
        cruiseLineId: HURTIGRUTEN_LINE_ID,
        contentHash: PNG_HASH,
        publicUrl: PUBLIC_URL
      }
    ),
  "insert_multiple_rows"
);
{
  const one = assertExactOneInsertedRow([mediaFixture()], {
    cruiseLineId: HURTIGRUTEN_LINE_ID,
    contentHash: PNG_HASH,
    publicUrl: PUBLIC_URL
  });
  assert(one.inserted_row_count === 1, "insert one");
}
passed += 1;

// verified PATCH enforcement (shared helper)
assertThrows(
  () =>
    assertExactOnePatchedRow([], {
      entityUuid: HURTIGRUTEN_LINE_ID,
      field: "logo_url",
      expectedValue: PUBLIC_URL
    }),
  "patch_zero_rows"
);
passed += 1;

// --- already-copied retry: skip upload+insert, promote only ---
{
  let uploads = 0;
  let inserts = 0;
  let patches = 0;
  const existing = mediaFixture();
  const result = await runApprovedLineLogoImport({
    cli: baseCli({ mode: "apply" }),
    mode: "apply",
    projectRef: PRODUCTION_REF,
    supabaseUrl: SUPABASE_URL,
    readLocalFile: async () => PNG_500,
    loadLine: async () => lineFixture({ logo_url: null }),
    loadLineMedia: async () => [existing],
    loadMediaByLineHash: async () => [existing],
    loadHxLines: async () => [],
    storageExists: async () => true,
    verifyPublicUrl: async () => true,
    writeRollbackManifest: async () => "/tmp/rollback-promote.json",
    uploadObject: async () => {
      uploads += 1;
    },
    insertMedia: async () => {
      inserts += 1;
      return [existing];
    },
    readMediaById: async () => existing,
    patchLineLogo: async ({ id, field, value }) => {
      patches += 1;
      return { status: 200, body: [{ id, [field]: value }] };
    },
    readLineField: async ({ id, field }) => ({ id, [field]: PUBLIC_URL }),
    countOtherLineChanges: async () => 0
  });
  assert(uploads === 0, "retry skip upload");
  assert(inserts === 0, "retry skip insert");
  assert(patches === 1, "retry promote");
  assert(result.writes.storage_uploads === 0, "retry upload count 0");
  assert(result.writes.media_library_inserts === 0, "retry insert count 0");
  assert(result.writes.cruise_line_updates === 1, "retry patch 1");
  assert(result.status === "promoted", "promote status");
}
passed += 1;

// --- already-complete: zero writes ---
{
  let uploads = 0;
  let inserts = 0;
  let patches = 0;
  let rollbacks = 0;
  const existing = mediaFixture();
  const result = await runApprovedLineLogoImport({
    cli: baseCli({ mode: "apply" }),
    mode: "apply",
    projectRef: PRODUCTION_REF,
    supabaseUrl: SUPABASE_URL,
    readLocalFile: async () => PNG_500,
    loadLine: async () => lineFixture({ logo_url: PUBLIC_URL }),
    loadLineMedia: async () => [existing],
    loadMediaByLineHash: async () => [existing],
    loadHxLines: async () => [],
    storageExists: async () => true,
    verifyPublicUrl: async () => true,
    writeRollbackManifest: async () => {
      rollbacks += 1;
      return "/tmp/should-not.json";
    },
    uploadObject: async () => {
      uploads += 1;
    },
    insertMedia: async () => {
      inserts += 1;
      return [existing];
    },
    readMediaById: async () => existing,
    patchLineLogo: async () => {
      patches += 1;
      return { status: 200, body: [] };
    },
    readLineField: async () => null
  });
  assert(result.status === "already_complete", "already complete");
  assert(uploads === 0 && inserts === 0 && patches === 0, "zero apply ops");
  assert(rollbacks === 0, "no rollback when already complete");
  assert(result.wrote === false, "not wrote");
  assert(JSON.stringify(result.writes) === JSON.stringify(emptyWriteCounts()), "empty writes");
}
passed += 1;

// --- insert failure retains storage; no logo_url ---
{
  let patches = 0;
  await assertThrowsAsync(
    () =>
      runApprovedLineLogoImport({
        cli: baseCli({ mode: "apply" }),
        mode: "apply",
        projectRef: PRODUCTION_REF,
        supabaseUrl: SUPABASE_URL,
        readLocalFile: async () => PNG_500,
        loadLine: async () => lineFixture(),
        loadLineMedia: async () => [],
        loadMediaByLineHash: async () => [],
        loadHxLines: async () => [],
        storageExists: async () => true,
        verifyPublicUrl: async () => true,
        writeRollbackManifest: async () => "/tmp/rollback-fail-insert.json",
        uploadObject: async () => {},
        insertMedia: async () => {
          throw new Error("insert boom");
        },
        readMediaById: async () => null,
        patchLineLogo: async () => {
          patches += 1;
          return { status: 200, body: [] };
        },
        readLineField: async () => null
      }),
    "approved_logo_insert_failed_storage_retained"
  );
  assert(patches === 0, "no patch after insert fail");
}
passed += 1;

// --- promote failure leaves media+storage ---
{
  await assertThrowsAsync(
    () =>
      runApprovedLineLogoImport({
        cli: baseCli({ mode: "apply" }),
        mode: "apply",
        projectRef: PRODUCTION_REF,
        supabaseUrl: SUPABASE_URL,
        readLocalFile: async () => PNG_500,
        loadLine: async () => lineFixture(),
        loadLineMedia: async () => [mediaFixture()],
        loadMediaByLineHash: async () => [mediaFixture()],
        loadHxLines: async () => [],
        storageExists: async () => true,
        verifyPublicUrl: async () => true,
        writeRollbackManifest: async () => "/tmp/rollback-fail-promote.json",
        uploadObject: async () => {
          throw new Error("should not upload");
        },
        insertMedia: async () => {
          throw new Error("should not insert");
        },
        readMediaById: async () => mediaFixture(),
        patchLineLogo: async () => ({ status: 200, body: [] }),
        readLineField: async () => lineFixture({ logo_url: null })
      }),
    "approved_logo_partial_promote_failed"
  );
}
passed += 1;

// --- no delete operation in runner source; local file never modified ---
{
  const runnerSrc = fs.readFileSync(
    path.join(ROOT, "scripts/lib/approved-line-logo-import/import-runner.js"),
    "utf8"
  );
  const cliSrc = fs.readFileSync(
    path.join(ROOT, "scripts/import-approved-line-logo.mjs"),
    "utf8"
  );
  assert(!/storageDelete\s*\(/.test(runnerSrc), "runner has no storageDelete call");
  assert(!/\.remove\s*\(/.test(cliSrc), "cli has no storage remove");
  assert(!/method:\s*["']DELETE["']/.test(cliSrc), "cli has no DELETE method");
  assert(!/writeFileSync\(\s*config\.local_path/.test(cliSrc), "cli never writes source");
  assert(
    !/writeFileSync\(\s*HURTIGRUTEN_LOCAL_PATH/.test(cliSrc),
    "cli never writes hurtigruten path"
  );
}
passed += 1;

// --- wrong project ref ---
await assertThrowsAsync(
  () =>
    runApprovedLineLogoImport({
      cli: baseCli({ mode: "dry-run" }),
      mode: "dry-run",
      projectRef: DEV_REF,
      supabaseUrl: `https://${DEV_REF}.supabase.co`,
      readLocalFile: async () => PNG_500,
      loadLine: async () => lineFixture(),
      loadLineMedia: async () => [],
      loadMediaByLineHash: async () => [],
      loadHxLines: async () => [],
      storageExists: async () => false,
      verifyPublicUrl: async () => true,
      writeRollbackManifest: async () => "/tmp/x.json"
    }),
  "approved_logo_wrong_project"
);
passed += 1;

// --- modifyLocalFile adapter rejected ---
await assertThrowsAsync(
  () =>
    runApprovedLineLogoImport({
      cli: baseCli({ mode: "dry-run" }),
      mode: "dry-run",
      projectRef: PRODUCTION_REF,
      supabaseUrl: SUPABASE_URL,
      readLocalFile: async () => PNG_500,
      loadLine: async () => lineFixture(),
      loadLineMedia: async () => [],
      loadMediaByLineHash: async () => [],
      loadHxLines: async () => [],
      storageExists: async () => false,
      verifyPublicUrl: async () => true,
      writeRollbackManifest: async () => "/tmp/x.json",
      modifyLocalFile: () => {}
    }),
  "approved_logo_local_modify_forbidden"
);
passed += 1;

console.log(`OK: ${passed} checks passed for approved line logo importer`);
