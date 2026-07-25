/**
 * Offline tests for Royal Caribbean superseded logo Media Library cleanup.
 * No network. No credentials. No live deletes.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RC_LINE_ID,
  RC_LINE_NAME,
  RC_CANONICAL_MEDIA_ID,
  RC_SUPERSEDED_MEDIA_ID,
  RC_CANONICAL_LOGO_URL,
  RC_SUPERSEDED_STORAGE_PATH,
  RC_CONFIRM_TOKEN,
  ICON_OF_THE_SEAS_MEDIA_ID,
  ICON_OF_THE_SEAS_SHIP_ID,
  assertRcLogoCleanupCliGate,
  assertRcLogoCleanupPreDelete,
  assertExactOneDeletedRow,
  assertRcLogoCleanupPostDelete,
  runRcLogoCleanup,
  summariseRcLogoCleanupWrites,
  assertRcCleanupWriteBanner
} from "./lib/media-coverage-audit/royal-caribbean-logo-cleanup-gate.js";
import {
  resolveMigrationTarget,
  formatTargetBanner,
  PRODUCTION_REF
} from "./lib/squarespace-ci-media/target.js";

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

const SUPERSEDED_URL =
  "https://xikbibxyinttllxamgao.supabase.co/storage/v1/object/public/cruise-media/general/1784610209293-d1622233-RC.jpg";

function fixtures() {
  return {
    line: {
      id: RC_LINE_ID,
      name: RC_LINE_NAME,
      logo_url: RC_CANONICAL_LOGO_URL,
      active: true
    },
    canonicalMedia: {
      id: RC_CANONICAL_MEDIA_ID,
      media_type: "cruise_line",
      cruise_line_id: RC_LINE_ID,
      ship_id: null,
      public_url: RC_CANONICAL_LOGO_URL,
      content_hash: "71e14b8c50c62e1a741cab97c22818fb9f3b591f53df298cbf1fee4eb9ec01e0",
      storage_path:
        "lines/1cea3c83-5fd5-41d0-b5f7-4026fee00ab5/71e14b8c50c6-Royal-Caribbean.png"
    },
    supersededMedia: {
      id: RC_SUPERSEDED_MEDIA_ID,
      media_type: "general",
      cruise_line_id: RC_LINE_ID,
      ship_id: null,
      public_url: SUPERSEDED_URL,
      content_hash: null,
      storage_path: RC_SUPERSEDED_STORAGE_PATH
    },
    iconMedia: {
      id: ICON_OF_THE_SEAS_MEDIA_ID,
      media_type: "ship",
      cruise_line_id: RC_LINE_ID,
      ship_id: ICON_OF_THE_SEAS_SHIP_ID,
      public_url: "https://example.supabase.co/icon.jpg"
    }
  };
}

async function main() {
  let passed = 0;
  const fx = fixtures();

  // wrong target aborts before network
  assertThrows(
    () =>
      assertRcLogoCleanupCliGate({
        target: "dev",
        deleteMediaRow: true,
        recordId: RC_SUPERSEDED_MEDIA_ID,
        confirmToken: RC_CONFIRM_TOKEN
      }),
    "rc_cleanup_target_invalid"
  );
  assertThrows(
    () =>
      assertRcLogoCleanupCliGate({
        target: null,
        deleteMediaRow: true,
        recordId: RC_SUPERSEDED_MEDIA_ID,
        confirmToken: RC_CONFIRM_TOKEN
      }),
    "rc_cleanup_target_invalid"
  );
  passed += 1;

  // wrong confirmation aborts
  assertThrows(
    () =>
      assertRcLogoCleanupCliGate({
        target: "production",
        deleteMediaRow: true,
        recordId: RC_SUPERSEDED_MEDIA_ID,
        confirmToken: "WRONG"
      }),
    "rc_cleanup_confirm_invalid"
  );
  passed += 1;

  // wrong record UUID aborts
  assertThrows(
    () =>
      assertRcLogoCleanupCliGate({
        target: "production",
        deleteMediaRow: true,
        recordId: RC_CANONICAL_MEDIA_ID,
        confirmToken: RC_CONFIRM_TOKEN
      }),
    "rc_cleanup_record_id_invalid"
  );
  passed += 1;

  assertRcLogoCleanupCliGate({
    target: "production",
    deleteMediaRow: true,
    recordId: RC_SUPERSEDED_MEDIA_ID,
    confirmToken: RC_CONFIRM_TOKEN
  });
  passed += 1;

  // canonical logo mismatch aborts
  assertThrows(
    () =>
      assertRcLogoCleanupPreDelete({
        ...fx,
        line: { ...fx.line, logo_url: SUPERSEDED_URL },
        otherRowsSharingStoragePath: [fx.supersededMedia],
        linesReferencingSupersededUrl: [],
        shipsReferencingSupersededUrl: [],
        canonicalUrlReachable: true
      }),
    "rc_cleanup_canonical_logo_mismatch"
  );
  passed += 1;

  // canonical Media Library row missing aborts
  assertThrows(
    () =>
      assertRcLogoCleanupPreDelete({
        ...fx,
        canonicalMedia: null,
        otherRowsSharingStoragePath: [fx.supersededMedia],
        linesReferencingSupersededUrl: [],
        shipsReferencingSupersededUrl: [],
        canonicalUrlReachable: true
      }),
    "rc_cleanup_canonical_media_missing"
  );
  passed += 1;

  // superseded row mismatch aborts
  assertThrows(
    () =>
      assertRcLogoCleanupPreDelete({
        ...fx,
        supersededMedia: {
          ...fx.supersededMedia,
          storage_path: "general/other.jpg"
        },
        otherRowsSharingStoragePath: [],
        linesReferencingSupersededUrl: [],
        shipsReferencingSupersededUrl: [],
        canonicalUrlReachable: true
      }),
    "rc_cleanup_superseded_path_mismatch"
  );
  passed += 1;

  // another record sharing the storage path aborts
  assertThrows(
    () =>
      assertRcLogoCleanupPreDelete({
        ...fx,
        otherRowsSharingStoragePath: [
          fx.supersededMedia,
          { id: "other-row", storage_path: RC_SUPERSEDED_STORAGE_PATH }
        ],
        linesReferencingSupersededUrl: [],
        shipsReferencingSupersededUrl: [],
        canonicalUrlReachable: true
      }),
    "rc_cleanup_storage_path_shared"
  );
  passed += 1;

  // canonical field referencing the superseded URL aborts
  assertThrows(
    () =>
      assertRcLogoCleanupPreDelete({
        ...fx,
        otherRowsSharingStoragePath: [fx.supersededMedia],
        linesReferencingSupersededUrl: [
          { id: RC_LINE_ID, logo_url: SUPERSEDED_URL }
        ],
        shipsReferencingSupersededUrl: [],
        canonicalUrlReachable: true
      }),
    "rc_cleanup_line_references_superseded"
  );
  assertThrows(
    () =>
      assertRcLogoCleanupPreDelete({
        ...fx,
        otherRowsSharingStoragePath: [fx.supersededMedia],
        linesReferencingSupersededUrl: [],
        shipsReferencingSupersededUrl: [
          { id: ICON_OF_THE_SEAS_SHIP_ID, hero_image_url: SUPERSEDED_URL }
        ],
        canonicalUrlReachable: true
      }),
    "rc_cleanup_ship_references_superseded"
  );
  passed += 1;

  assertRcLogoCleanupPreDelete({
    ...fx,
    otherRowsSharingStoragePath: [fx.supersededMedia],
    linesReferencingSupersededUrl: [],
    shipsReferencingSupersededUrl: [],
    canonicalUrlReachable: true
  });
  passed += 1;

  // exactly one Media Library row deleted
  assertExactOneDeletedRow([{ id: RC_SUPERSEDED_MEDIA_ID }], RC_SUPERSEDED_MEDIA_ID);
  assertThrows(() => assertExactOneDeletedRow([], RC_SUPERSEDED_MEDIA_ID), "rc_cleanup_delete_zero_rows");
  assertThrows(
    () =>
      assertExactOneDeletedRow(
        [{ id: RC_SUPERSEDED_MEDIA_ID }, { id: "x" }],
        RC_SUPERSEDED_MEDIA_ID
      ),
    "rc_cleanup_delete_multiple_rows"
  );
  passed += 1;

  // end-to-end injectable cleanup: Storage delete never called; rollback before delete
  const order = [];
  let storageDeleteCalled = false;
  const media = new Map([
    [RC_CANONICAL_MEDIA_ID, { ...fx.canonicalMedia }],
    [RC_SUPERSEDED_MEDIA_ID, { ...fx.supersededMedia }],
    [ICON_OF_THE_SEAS_MEDIA_ID, { ...fx.iconMedia }]
  ]);
  let lineState = { ...fx.line };
  let rollbackWritten = false;
  let deletedCount = 0;

  const result = await runRcLogoCleanup({
    cli: {
      target: "production",
      deleteMediaRow: true,
      recordId: RC_SUPERSEDED_MEDIA_ID,
      confirmToken: RC_CONFIRM_TOKEN
    },
    loadLine: async (id) => {
      order.push(`loadLine:${id}`);
      return String(id) === RC_LINE_ID ? { ...lineState } : null;
    },
    loadMediaById: async (id) => {
      order.push(`loadMedia:${id}`);
      return media.has(id) ? { ...media.get(id) } : null;
    },
    loadByStoragePath: async (p) => {
      order.push(`loadPath:${p}`);
      return [...media.values()].filter((m) => m.storage_path === p);
    },
    loadLinesByLogoUrl: async (url) => {
      order.push("loadLinesByLogo");
      return lineState.logo_url === url ? [{ ...lineState }] : [];
    },
    loadShipsByHeroUrl: async () => {
      order.push("loadShipsByHero");
      return [];
    },
    verifyUrl: async () => {
      order.push("verifyUrl");
      return true;
    },
    storageExists: async () => {
      order.push("storageExists");
      return true;
    },
    writeRollback: async (row) => {
      order.push("writeRollback");
      rollbackWritten = true;
      assert(String(row.id) === RC_SUPERSEDED_MEDIA_ID, "rollback row");
      assert(deletedCount === 0, "rollback before delete");
      return "/tmp/fake-rollback.json";
    },
    deleteMediaRow: async (id) => {
      order.push(`delete:${id}`);
      assert(rollbackWritten === true, "must rollback first");
      assert(String(id) === RC_SUPERSEDED_MEDIA_ID, "delete only superseded");
      deletedCount += 1;
      const row = media.get(id);
      media.delete(id);
      return [{ ...row }];
    },
    storageDelete: async () => {
      storageDeleteCalled = true;
      throw new Error("should never be called");
    }
  });

  assert(storageDeleteCalled === false, "storage delete never called");
  assert(deletedCount === 1, "exactly one delete");
  assert(result.storage_deleted === false, "storage_deleted false");
  assert(result.dev_writes === 0, "dev 0");
  assert(result.canonical_media_id === RC_CANONICAL_MEDIA_ID, "canonical kept");
  assert(result.logo_url === RC_CANONICAL_LOGO_URL, "logo unchanged");
  assert(result.icon_media_id === ICON_OF_THE_SEAS_MEDIA_ID, "icon untouched");
  assert(media.has(RC_CANONICAL_MEDIA_ID), "canonical remains in map");
  assert(!media.has(RC_SUPERSEDED_MEDIA_ID), "superseded removed");
  assert(media.has(ICON_OF_THE_SEAS_MEDIA_ID), "icon remains");
  assert(order.indexOf("writeRollback") < order.indexOf(`delete:${RC_SUPERSEDED_MEDIA_ID}`), "rollback before delete");
  passed += 1;

  // post-delete asserts
  assertRcLogoCleanupPostDelete({
    supersededAfter: null,
    canonicalAfter: fx.canonicalMedia,
    lineAfter: fx.line,
    supersededStorageExists: true,
    canonicalUrlReachable: true,
    iconMediaAfter: fx.iconMedia
  });
  assertThrows(
    () =>
      assertRcLogoCleanupPostDelete({
        supersededAfter: null,
        canonicalAfter: fx.canonicalMedia,
        lineAfter: { ...fx.line, logo_url: SUPERSEDED_URL },
        supersededStorageExists: true,
        canonicalUrlReachable: true,
        iconMediaAfter: fx.iconMedia
      }),
    "rc_cleanup_logo_url_changed"
  );
  passed += 1;

  // CLI source: no Storage DELETE
  const cliPath = path.join(__dirname, "cleanup-royal-caribbean-logo-duplicate.mjs");
  const cliSrc = fs.readFileSync(cliPath, "utf8");
  assert(!/storage\/v1\/object\/.*\n.*DELETE|method:\s*["']DELETE["'].*storage/i.test(cliSrc), "no storage delete pattern");
  assert(!/storageDelete|deleteObject|x-upsert/.test(cliSrc), "no storage write helpers");
  assert(/return=representation/.test(cliSrc), "delete representation");
  assert(/assertRcLogoCleanupCliGate/.test(cliSrc), "cli gate");
  assert(/rollback/.test(cliSrc.toLowerCase()), "rollback");
  // Only media_library DELETE allowed
  assert(/DELETE", "media_library"/.test(cliSrc) || /DELETE',\s*'media_library'/.test(cliSrc) || /"DELETE", "media_library"/.test(cliSrc), "deletes media_library");
  assert(/assertRcCleanupWriteBanner/.test(cliSrc), "banner guard");
  assert(/summariseRcLogoCleanupWrites/.test(cliSrc), "write summary");
  passed += 1;

  // delete mode never reports "Writes: no"
  const prodEnv = {
    SUPABASE_URL: `https://${PRODUCTION_REF}.supabase.co`,
    SUPABASE_SERVICE_ROLE_KEY: "prod-secret"
  };
  const deleteResolved = resolveMigrationTarget({
    target: "production",
    mode: "delete-media-row",
    env: prodEnv
  });
  assert(deleteResolved.production_media_library_delete_gated === true, "ml delete gated");
  const deleteBanner = formatTargetBanner(deleteResolved, "delete-media-row");
  assertRcCleanupWriteBanner(deleteBanner);
  assert(!/\bWrites:\s*no\b/i.test(deleteBanner), "not writes no");
  assert(
    /Writes: gated Original-project Media Library delete only/.test(deleteBanner),
    "exact write note"
  );
  const dryBanner = formatTargetBanner(
    resolveMigrationTarget({ target: "production", mode: "dry-run", env: prodEnv }),
    "dry-run"
  );
  assert(/\bWrites:\s*no\b/.test(dryBanner), "dry-run still writes no");
  assertThrows(
    () => assertRcCleanupWriteBanner("Selected target: production\nWrites: no"),
    "rc_cleanup_banner_writes_no"
  );
  passed += 1;

  // write accounting: exactly one ML delete; inserts/updates/storage/dev = 0
  const writes = summariseRcLogoCleanupWrites({ mediaLibraryDeletes: 1 });
  assert(writes.media_library_deletes === 1, "one delete");
  assert(writes.database_inserts === 0, "inserts 0");
  assert(writes.database_updates === 0, "updates 0");
  assert(writes.storage_deletes === 0, "storage deletes 0");
  assert(writes.storage_writes === 0, "storage writes 0");
  assert(writes.dev_writes === 0, "dev 0");
  assertThrows(
    () => summariseRcLogoCleanupWrites({ mediaLibraryDeletes: 0 }),
    "rc_cleanup_write_count_invalid"
  );
  assertThrows(
    () => summariseRcLogoCleanupWrites({ mediaLibraryDeletes: 2 }),
    "rc_cleanup_write_count_invalid"
  );
  passed += 1;

  console.log(`PASS ${passed} royal-caribbean logo cleanup tests`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
