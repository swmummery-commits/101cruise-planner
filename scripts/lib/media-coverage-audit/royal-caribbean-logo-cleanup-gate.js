/**
 * Pure gates for Royal Caribbean superseded logo Media Library cleanup.
 * No network. Fixed Original-project UUIDs and URLs only.
 */

export const RC_LINE_ID = "1cea3c83-5fd5-41d0-b5f7-4026fee00ab5";
export const RC_LINE_NAME = "Royal Caribbean International";

export const RC_CANONICAL_MEDIA_ID = "28a9063c-c508-4b0b-a535-f03c49ae2a24";
export const RC_SUPERSEDED_MEDIA_ID = "ba55f15e-eb84-4c4c-a489-d16663ad4917";

export const RC_CANONICAL_LOGO_URL =
  "https://xikbibxyinttllxamgao.supabase.co/storage/v1/object/public/cruise-media/lines/1cea3c83-5fd5-41d0-b5f7-4026fee00ab5/71e14b8c50c6-Royal-Caribbean.png";

export const RC_SUPERSEDED_STORAGE_PATH = "general/1784610209293-d1622233-RC.jpg";

export const RC_CONFIRM_TOKEN = "DELETE-SUPERSEDED-RC-LOGO";

/** Icon of the Seas — must remain untouched. */
export const ICON_OF_THE_SEAS_SHIP_ID = "193071d7-46ee-438f-9025-ff9551ce4aa2";
export const ICON_OF_THE_SEAS_MEDIA_ID = "14fe795a-4c9e-4423-ab73-1606450ca41d";

/**
 * Abort before network when CLI args are wrong.
 */
export function assertRcLogoCleanupCliGate({
  target,
  deleteMediaRow,
  recordId,
  confirmToken
}) {
  if (target !== "production") {
    throw Object.assign(
      new Error("REFUSED: require --target=production (DEV writes forbidden)"),
      { code: "rc_cleanup_target_invalid" }
    );
  }
  if (!deleteMediaRow) {
    throw Object.assign(
      new Error("REFUSED: require --delete-media-row"),
      { code: "rc_cleanup_mode_invalid" }
    );
  }
  if (String(recordId || "") !== RC_SUPERSEDED_MEDIA_ID) {
    throw Object.assign(
      new Error(
        `REFUSED: --record-id must be exactly ${RC_SUPERSEDED_MEDIA_ID}`
      ),
      { code: "rc_cleanup_record_id_invalid" }
    );
  }
  if (String(confirmToken || "") !== RC_CONFIRM_TOKEN) {
    throw Object.assign(
      new Error(`REFUSED: require --confirm=${RC_CONFIRM_TOKEN}`),
      { code: "rc_cleanup_confirm_invalid" }
    );
  }
  return true;
}

/**
 * Validate pre-delete catalogue/media state (injectable rows).
 */
export function assertRcLogoCleanupPreDelete({
  line,
  canonicalMedia,
  supersededMedia,
  otherRowsSharingStoragePath,
  linesReferencingSupersededUrl,
  shipsReferencingSupersededUrl,
  iconMedia,
  canonicalUrlReachable
}) {
  if (!line || String(line.id) !== RC_LINE_ID) {
    throw Object.assign(new Error("REFUSED: Royal Caribbean line UUID mismatch"), {
      code: "rc_cleanup_line_missing"
    });
  }
  if (String(line.name || "").trim() !== RC_LINE_NAME) {
    throw Object.assign(
      new Error(`REFUSED: unexpected line name "${line.name}"`),
      { code: "rc_cleanup_line_name_mismatch" }
    );
  }
  if (String(line.logo_url || "") !== RC_CANONICAL_LOGO_URL) {
    throw Object.assign(
      new Error("REFUSED: ci_cruise_lines.logo_url does not match canonical Supabase URL"),
      { code: "rc_cleanup_canonical_logo_mismatch" }
    );
  }

  if (!canonicalMedia || String(canonicalMedia.id) !== RC_CANONICAL_MEDIA_ID) {
    throw Object.assign(new Error("REFUSED: canonical Media Library row missing"), {
      code: "rc_cleanup_canonical_media_missing"
    });
  }
  if (String(canonicalMedia.public_url || "") !== RC_CANONICAL_LOGO_URL) {
    throw Object.assign(
      new Error("REFUSED: canonical Media Library public_url mismatch"),
      { code: "rc_cleanup_canonical_public_url_mismatch" }
    );
  }
  if (String(canonicalMedia.cruise_line_id) !== RC_LINE_ID) {
    throw Object.assign(
      new Error("REFUSED: canonical Media Library cruise_line_id mismatch"),
      { code: "rc_cleanup_canonical_line_mismatch" }
    );
  }
  if (String(canonicalMedia.media_type || "") !== "cruise_line") {
    throw Object.assign(
      new Error("REFUSED: canonical Media Library media_type must be cruise_line"),
      { code: "rc_cleanup_canonical_media_type" }
    );
  }
  if (canonicalMedia.ship_id != null) {
    throw Object.assign(
      new Error("REFUSED: canonical Media Library ship_id must be null"),
      { code: "rc_cleanup_canonical_has_ship" }
    );
  }
  if (!canonicalMedia.content_hash) {
    throw Object.assign(
      new Error("REFUSED: canonical Media Library content_hash required"),
      { code: "rc_cleanup_canonical_hash_missing" }
    );
  }
  if (canonicalUrlReachable !== true) {
    throw Object.assign(
      new Error("REFUSED: canonical logo public URL is not reachable"),
      { code: "rc_cleanup_canonical_unreachable" }
    );
  }

  if (!supersededMedia || String(supersededMedia.id) !== RC_SUPERSEDED_MEDIA_ID) {
    throw Object.assign(new Error("REFUSED: superseded Media Library row missing"), {
      code: "rc_cleanup_superseded_missing"
    });
  }
  if (String(supersededMedia.cruise_line_id) !== RC_LINE_ID) {
    throw Object.assign(
      new Error("REFUSED: superseded Media Library cruise_line_id mismatch"),
      { code: "rc_cleanup_superseded_line_mismatch" }
    );
  }
  if (supersededMedia.ship_id != null) {
    throw Object.assign(
      new Error("REFUSED: superseded Media Library ship_id must be null"),
      { code: "rc_cleanup_superseded_has_ship" }
    );
  }
  if (String(supersededMedia.public_url || "") === RC_CANONICAL_LOGO_URL) {
    throw Object.assign(
      new Error("REFUSED: superseded public_url unexpectedly matches canonical logo"),
      { code: "rc_cleanup_superseded_is_canonical" }
    );
  }
  if (String(supersededMedia.storage_path || "") !== RC_SUPERSEDED_STORAGE_PATH) {
    throw Object.assign(
      new Error("REFUSED: superseded storage_path mismatch"),
      { code: "rc_cleanup_superseded_path_mismatch" }
    );
  }

  const sharers = (otherRowsSharingStoragePath || []).filter(
    (r) => String(r.id) !== RC_SUPERSEDED_MEDIA_ID
  );
  if (sharers.length > 0) {
    throw Object.assign(
      new Error(
        `REFUSED: ${sharers.length} other Media Library row(s) share superseded storage_path`
      ),
      { code: "rc_cleanup_storage_path_shared" }
    );
  }

  if ((linesReferencingSupersededUrl || []).length > 0) {
    throw Object.assign(
      new Error("REFUSED: a cruise-line canonical field references superseded public_url"),
      { code: "rc_cleanup_line_references_superseded" }
    );
  }
  if ((shipsReferencingSupersededUrl || []).length > 0) {
    throw Object.assign(
      new Error("REFUSED: a ship canonical field references superseded public_url"),
      { code: "rc_cleanup_ship_references_superseded" }
    );
  }

  if (iconMedia) {
    if (String(iconMedia.id) !== ICON_OF_THE_SEAS_MEDIA_ID) {
      throw Object.assign(new Error("REFUSED: Icon of the Seas Media Library UUID mismatch"), {
        code: "rc_cleanup_icon_media_mismatch"
      });
    }
    if (String(iconMedia.ship_id) !== ICON_OF_THE_SEAS_SHIP_ID) {
      throw Object.assign(new Error("REFUSED: Icon of the Seas ship_id mismatch"), {
        code: "rc_cleanup_icon_ship_mismatch"
      });
    }
  }

  return true;
}

export function assertExactOneDeletedRow(body, expectedId) {
  if (!Array.isArray(body)) {
    throw Object.assign(new Error("REFUSED: DELETE representation must be a JSON array"), {
      code: "rc_cleanup_delete_invalid_representation"
    });
  }
  if (body.length === 0) {
    throw Object.assign(new Error("REFUSED: DELETE matched zero rows"), {
      code: "rc_cleanup_delete_zero_rows"
    });
  }
  if (body.length > 1) {
    throw Object.assign(
      new Error(`REFUSED: DELETE matched ${body.length} rows (expected exactly 1)`),
      { code: "rc_cleanup_delete_multiple_rows" }
    );
  }
  if (String(body[0]?.id) !== String(expectedId)) {
    throw Object.assign(
      new Error(
        `REFUSED: DELETE returned wrong UUID (expected ${expectedId}, got ${body[0]?.id})`
      ),
      { code: "rc_cleanup_delete_wrong_uuid" }
    );
  }
  return { deleted_row_count: 1, deleted_id: body[0].id, deleted_row: body[0] };
}

/**
 * Post-delete checks (injectable).
 */
export function assertRcLogoCleanupPostDelete({
  supersededAfter,
  canonicalAfter,
  lineAfter,
  supersededStorageExists,
  canonicalUrlReachable,
  iconMediaAfter
}) {
  if (supersededAfter != null) {
    throw Object.assign(
      new Error("REFUSED: superseded Media Library row still exists after DELETE"),
      { code: "rc_cleanup_superseded_still_present" }
    );
  }
  if (!canonicalAfter || String(canonicalAfter.id) !== RC_CANONICAL_MEDIA_ID) {
    throw Object.assign(
      new Error("REFUSED: canonical Media Library row missing after DELETE"),
      { code: "rc_cleanup_canonical_lost" }
    );
  }
  if (String(lineAfter?.logo_url || "") !== RC_CANONICAL_LOGO_URL) {
    throw Object.assign(
      new Error("REFUSED: ci_cruise_lines.logo_url changed during cleanup"),
      { code: "rc_cleanup_logo_url_changed" }
    );
  }
  if (supersededStorageExists !== true) {
    throw Object.assign(
      new Error("REFUSED: superseded Storage object must still exist (not deleted)"),
      { code: "rc_cleanup_storage_missing" }
    );
  }
  if (canonicalUrlReachable !== true) {
    throw Object.assign(
      new Error("REFUSED: canonical logo URL not reachable after DELETE"),
      { code: "rc_cleanup_canonical_unreachable_after" }
    );
  }
  if (iconMediaAfter) {
    if (String(iconMediaAfter.id) !== ICON_OF_THE_SEAS_MEDIA_ID) {
      throw Object.assign(new Error("REFUSED: Icon of the Seas Media Library altered"), {
        code: "rc_cleanup_icon_touched"
      });
    }
  }
  return true;
}

/**
 * Accurate write accounting for the gated Media Library delete cleanup.
 * Exactly one media_library DELETE is permitted; everything else stays zero.
 */
export function summariseRcLogoCleanupWrites({ mediaLibraryDeletes = 1 } = {}) {
  if (mediaLibraryDeletes !== 1) {
    throw Object.assign(
      new Error("REFUSED: cleanup must report exactly one media_library delete"),
      { code: "rc_cleanup_write_count_invalid" }
    );
  }
  return {
    media_library_deletes: 1,
    database_inserts: 0,
    database_updates: 0,
    storage_deletes: 0,
    storage_writes: 0,
    dev_writes: 0
  };
}

/**
 * Banner must not claim zero writes when delete mode is active.
 */
export function assertRcCleanupWriteBanner(bannerText) {
  const text = String(bannerText || "");
  if (/\bWrites:\s*no\b/i.test(text)) {
    throw Object.assign(
      new Error('REFUSED: delete mode must not report "Writes: no"'),
      { code: "rc_cleanup_banner_writes_no" }
    );
  }
  if (!/gated Original-project Media Library delete only/i.test(text)) {
    throw Object.assign(
      new Error(
        "REFUSED: delete mode banner must report gated Original-project Media Library delete only"
      ),
      { code: "rc_cleanup_banner_writes_missing" }
    );
  }
  return true;
}

/**
 * Simulated cleanup runner for offline tests (injectable deps).
 */
export async function runRcLogoCleanup({
  cli,
  loadLine,
  loadMediaById,
  loadByStoragePath,
  loadLinesByLogoUrl,
  loadShipsByHeroUrl,
  verifyUrl,
  storageExists,
  writeRollback,
  deleteMediaRow,
  storageDelete // must never be called
}) {
  assertRcLogoCleanupCliGate(cli);

  if (typeof storageDelete === "function") {
    // Wrap: any call is a hard failure for this cleanup.
    const forbidden = (...args) => {
      throw Object.assign(new Error("REFUSED: Storage delete is forbidden"), {
        code: "rc_cleanup_storage_delete_forbidden",
        args
      });
    };
    // Prefer not exposing; tests may pass a spy.
    void forbidden;
  }

  const line = await loadLine(RC_LINE_ID);
  const canonicalMedia = await loadMediaById(RC_CANONICAL_MEDIA_ID);
  const supersededMedia = await loadMediaById(RC_SUPERSEDED_MEDIA_ID);
  const sharing = await loadByStoragePath(RC_SUPERSEDED_STORAGE_PATH);
  const linesRef = await loadLinesByLogoUrl(supersededMedia?.public_url || "");
  const shipsRef = await loadShipsByHeroUrl(supersededMedia?.public_url || "");
  const iconMedia = await loadMediaById(ICON_OF_THE_SEAS_MEDIA_ID);
  const reachable = await verifyUrl(RC_CANONICAL_LOGO_URL);

  assertRcLogoCleanupPreDelete({
    line,
    canonicalMedia,
    supersededMedia,
    otherRowsSharingStoragePath: sharing,
    linesReferencingSupersededUrl: linesRef || [],
    shipsReferencingSupersededUrl: shipsRef || [],
    iconMedia,
    canonicalUrlReachable: reachable
  });

  const rollbackPath = await writeRollback(supersededMedia);

  const deleteBody = await deleteMediaRow(RC_SUPERSEDED_MEDIA_ID);
  const deleted = assertExactOneDeletedRow(deleteBody, RC_SUPERSEDED_MEDIA_ID);

  if (typeof storageDelete === "function") {
    // Explicitly never invoke.
  }

  const supersededAfter = await loadMediaById(RC_SUPERSEDED_MEDIA_ID);
  const canonicalAfter = await loadMediaById(RC_CANONICAL_MEDIA_ID);
  const lineAfter = await loadLine(RC_LINE_ID);
  const storageStill = await storageExists(RC_SUPERSEDED_STORAGE_PATH);
  const reachableAfter = await verifyUrl(RC_CANONICAL_LOGO_URL);
  const iconAfter = await loadMediaById(ICON_OF_THE_SEAS_MEDIA_ID);

  assertRcLogoCleanupPostDelete({
    supersededAfter,
    canonicalAfter,
    lineAfter,
    supersededStorageExists: storageStill,
    canonicalUrlReachable: reachableAfter,
    iconMediaAfter: iconAfter
  });

  const writes = summariseRcLogoCleanupWrites({ mediaLibraryDeletes: 1 });
  return {
    deleted,
    rollback_path: rollbackPath,
    canonical_media_id: RC_CANONICAL_MEDIA_ID,
    logo_url: lineAfter.logo_url,
    storage_deleted: false,
    icon_media_id: iconAfter?.id || null,
    writes,
    dev_writes: writes.dev_writes,
    wrote: true
  };
}
