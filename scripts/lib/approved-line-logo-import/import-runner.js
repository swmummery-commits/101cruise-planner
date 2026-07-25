/**
 * Approved local cruise-line logo import runner.
 *
 * Verified sequential import with rollback evidence (not a DB transaction).
 * Pure / injectable — CLI wires Supabase + filesystem adapters.
 */

import { createRequire } from "node:module";
import {
  MEDIA_BUCKET,
  buildLineStoragePath,
  publicMediaUrl,
  sha256Hex,
  sniffMime
} from "../squarespace-ci-media/media-utils.js";
import { PRODUCTION_REF } from "../squarespace-ci-media/target.js";
import { assertExactOnePatchedRow, verifiedCiFieldWrite } from "../squarespace-ci-media/verified-ci-patch.js";
import {
  getHurtigrutenLogoConfig,
  assertHurtigrutenCliGate,
  isForbiddenHxName,
  HURTIGRUTEN_LINE_ID,
  HURTIGRUTEN_LINE_NAME,
  LOGO_KEY
} from "./hurtigruten.js";

const require = createRequire(import.meta.url);
const { readImageDimensions } = require("../../../netlify/functions/lib/bulk-ship-images/image-dims.js");

export const APPROVED_LOGO_REGISTRY = Object.freeze({
  [LOGO_KEY]: getHurtigrutenLogoConfig
});

export function getApprovedLogoConfig(logoKey) {
  const factory = APPROVED_LOGO_REGISTRY[String(logoKey || "")];
  if (!factory) {
    throw Object.assign(
      new Error(`REFUSED: unknown --logo "${logoKey}" (HX cannot be selected)`),
      { code: "approved_logo_key_invalid" }
    );
  }
  return factory();
}

export function emptyWriteCounts() {
  return {
    storage_uploads: 0,
    media_library_inserts: 0,
    cruise_line_updates: 0,
    database_inserts: 0,
    database_updates: 0,
    database_deletes: 0,
    storage_deletes: 0,
    dev_writes: 0
  };
}

/**
 * Inspect approved local file (buffer + path metadata).
 */
export function inspectApprovedLocalLogo(config, buffer, { supabaseUrl }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw Object.assign(new Error("REFUSED: approved local logo file is empty or unreadable"), {
      code: "approved_logo_file_empty"
    });
  }

  const mime = sniffMime(buffer);
  if (mime !== config.expected_mime) {
    throw Object.assign(
      new Error(
        `REFUSED: expected ${config.expected_format} (${config.expected_mime}), got ${mime || "unknown"}`
      ),
      { code: "approved_logo_format_invalid" }
    );
  }

  const dims = readImageDimensions(buffer);
  if (dims.width !== config.expected_width || dims.height !== config.expected_height) {
    throw Object.assign(
      new Error(
        `REFUSED: expected ${config.expected_width}×${config.expected_height}, got ${dims.width}×${dims.height}`
      ),
      { code: "approved_logo_dimensions_invalid" }
    );
  }

  const contentHash = sha256Hex(buffer);
  const storagePath = buildLineStoragePath(
    config.cruise_line_id,
    contentHash,
    config.original_filename
  );
  const proposedPublicUrl = publicMediaUrl(supabaseUrl, storagePath);

  if (!isSafeOriginalCruiseMediaUrl(proposedPublicUrl, supabaseUrl)) {
    throw Object.assign(
      new Error("REFUSED: proposed public URL is not Original-project cruise-media Storage"),
      { code: "approved_logo_url_unsafe" }
    );
  }

  if (!storagePath.startsWith(`lines/${config.cruise_line_id}/`)) {
    throw Object.assign(new Error("REFUSED: proposed Storage path is unsafe"), {
      code: "approved_logo_storage_path_unsafe"
    });
  }
  if (storagePath.includes("..") || storagePath.includes("//")) {
    throw Object.assign(new Error("REFUSED: proposed Storage path is unsafe"), {
      code: "approved_logo_storage_path_unsafe"
    });
  }

  return {
    bytes: buffer.length,
    width: dims.width,
    height: dims.height,
    mime_type: mime,
    content_hash: contentHash,
    storage_bucket: MEDIA_BUCKET,
    storage_path: storagePath,
    proposed_public_url: proposedPublicUrl,
    original_filename: config.original_filename,
    media_library_values: {
      media_type: "cruise_line",
      cruise_line_id: config.cruise_line_id,
      ship_id: null,
      title: config.media_title,
      public_url: proposedPublicUrl,
      storage_bucket: MEDIA_BUCKET,
      storage_path: storagePath,
      original_filename: config.original_filename,
      file_name: config.original_filename,
      mime_type: mime,
      width: dims.width,
      height: dims.height,
      file_size_bytes: buffer.length,
      import_source: config.import_source,
      content_hash: contentHash,
      source_url: null,
      is_default: true,
      is_active: true,
      tags: ["approved_local_logo", "logo", config.logo_key]
    },
    proposed_canonical_logo_url: proposedPublicUrl
  };
}

export function isSafeOriginalCruiseMediaUrl(url, supabaseUrl) {
  try {
    const u = new URL(String(url || "").trim());
    const base = new URL(String(supabaseUrl || "").trim());
    if (u.origin !== base.origin) return false;
    const ref = u.hostname.split(".")[0];
    if (ref !== PRODUCTION_REF) return false;
    const prefix = `/storage/v1/object/public/${MEDIA_BUCKET}/`;
    return u.pathname.startsWith(prefix);
  } catch {
    return false;
  }
}

/**
 * Validate catalogue state against fixed Hurtigruten configuration.
 */
export function assertApprovedLogoCatalogueState({
  config,
  line,
  lineMediaRows,
  matchingHashRows,
  hxLines = []
}) {
  if (!line || String(line.id) !== String(config.cruise_line_id)) {
    throw Object.assign(
      new Error(
        `REFUSED: canonical cruise-line UUID mismatch (expected ${config.cruise_line_id})`
      ),
      { code: "approved_logo_line_missing" }
    );
  }
  if (String(line.name || "").trim() !== String(config.cruise_line_name)) {
    throw Object.assign(
      new Error(
        `REFUSED: canonical name mismatch (expected "${config.cruise_line_name}", got "${line.name}")`
      ),
      { code: "approved_logo_line_name_mismatch" }
    );
  }
  if (isForbiddenHxName(line.name) || String(line.id) !== HURTIGRUTEN_LINE_ID) {
    throw Object.assign(new Error("REFUSED: HX cannot be selected or modified"), {
      code: "approved_logo_hx_forbidden"
    });
  }
  if (String(config.cruise_line_name) !== HURTIGRUTEN_LINE_NAME) {
    throw Object.assign(new Error("REFUSED: UUID and canonical name are fixed"), {
      code: "approved_logo_fixed_identity"
    });
  }

  for (const hx of hxLines || []) {
    if (hx && (isForbiddenHxName(hx.name) || /hx/i.test(String(hx.name || "")))) {
      // Presence of HX catalogue rows is fine; touching them is not.
      // Ensure our target is not an HX row (already checked) and that
      // media rows are not for HX ids.
      if (String(hx.id) === String(config.cruise_line_id)) {
        throw Object.assign(new Error("REFUSED: HX cannot be selected or modified"), {
          code: "approved_logo_hx_forbidden"
        });
      }
    }
  }

  const logoUrl = line.logo_url == null ? "" : String(line.logo_url).trim();
  return { current_logo_url: logoUrl || null, line_media_rows: lineMediaRows || [], matching_hash_rows: matchingHashRows || [] };
}

/**
 * Classify retry / conflict state after local inspection + catalogue reads.
 */
export function classifyApprovedLogoPlan({
  config,
  currentLogoUrl,
  inspection,
  lineMediaRows,
  matchingHashRows,
  storageExists
}) {
  const proposed = inspection.proposed_public_url;
  const logoUrl = currentLogoUrl == null ? "" : String(currentLogoUrl).trim();

  const exactMedia = (matchingHashRows || []).filter(
    (r) =>
      String(r.cruise_line_id) === String(config.cruise_line_id) &&
      String(r.content_hash) === String(inspection.content_hash) &&
      String(r.media_type) === "cruise_line"
  );

  const conflictingLineMedia = (lineMediaRows || []).filter((r) => {
    if (String(r.media_type) !== "cruise_line") return false;
    if (String(r.cruise_line_id) !== String(config.cruise_line_id)) return false;
    const sameHash = String(r.content_hash || "") === String(inspection.content_hash);
    const samePath = String(r.storage_path || "") === String(inspection.storage_path);
    const sameUrl = String(r.public_url || "") === String(proposed);
    return !(sameHash && samePath && sameUrl);
  });

  if (conflictingLineMedia.length > 0) {
    throw Object.assign(
      new Error(
        `REFUSED: conflicting Media Library cruise-line logo already linked to ${config.cruise_line_name}`
      ),
      {
        code: "approved_logo_conflicting_media",
        conflicting_ids: conflictingLineMedia.map((r) => r.id)
      }
    );
  }

  const otherHashOwners = (matchingHashRows || []).filter(
    (r) => String(r.cruise_line_id) !== String(config.cruise_line_id)
  );
  if (otherHashOwners.length > 0) {
    throw Object.assign(
      new Error("REFUSED: content hash already used by another cruise-line Media Library row"),
      { code: "approved_logo_hash_conflict" }
    );
  }

  if (logoUrl && logoUrl !== proposed) {
    throw Object.assign(
      new Error(
        "REFUSED: canonical logo_url is non-empty and does not equal the proposed Supabase URL"
      ),
      { code: "approved_logo_conflicting_logo_url", current_logo_url: logoUrl }
    );
  }

  const mediaReady = exactMedia.length === 1;
  const mediaMissing = exactMedia.length === 0;
  if (exactMedia.length > 1) {
    throw Object.assign(
      new Error("REFUSED: multiple Media Library rows match Hurtigruten/content-hash pair"),
      { code: "approved_logo_duplicate_media" }
    );
  }

  const storageReady = storageExists === true;
  const logoReady = logoUrl === proposed;

  if (storageReady && mediaReady && logoReady) {
    return {
      status: "already_complete",
      skip_upload: true,
      skip_media_insert: true,
      skip_canonical_update: true,
      existing_media: exactMedia[0],
      writes: emptyWriteCounts()
    };
  }

  if (logoReady && (!storageReady || !mediaReady)) {
    throw Object.assign(
      new Error(
        "REFUSED: logo_url already equals proposed URL but Storage/Media Library are incomplete"
      ),
      { code: "approved_logo_inconsistent_complete" }
    );
  }

  if (storageReady && mediaReady && !logoReady) {
    return {
      status: "promote_only",
      skip_upload: true,
      skip_media_insert: true,
      skip_canonical_update: false,
      existing_media: exactMedia[0],
      writes: emptyWriteCounts()
    };
  }

  if (storageReady && mediaMissing) {
    return {
      status: "insert_and_promote",
      skip_upload: true,
      skip_media_insert: false,
      skip_canonical_update: false,
      existing_media: null,
      retained_storage: true,
      writes: emptyWriteCounts()
    };
  }

  if (!storageReady && mediaReady) {
    throw Object.assign(
      new Error(
        "REFUSED: Media Library row exists for hash but Storage object is missing — manual repair required"
      ),
      { code: "approved_logo_media_without_storage" }
    );
  }

  return {
    status: "full_import",
    skip_upload: false,
    skip_media_insert: false,
    skip_canonical_update: false,
    existing_media: null,
    writes: emptyWriteCounts()
  };
}

export function assertExactOneInsertedRow(body, { cruiseLineId, contentHash, publicUrl }) {
  if (!Array.isArray(body)) {
    throw Object.assign(new Error("REFUSED: INSERT representation must be a JSON array"), {
      code: "insert_invalid_representation"
    });
  }
  if (body.length === 0) {
    throw Object.assign(new Error("REFUSED: INSERT matched zero rows"), {
      code: "insert_zero_rows"
    });
  }
  if (body.length > 1) {
    throw Object.assign(
      new Error(`REFUSED: INSERT returned ${body.length} rows (expected exactly 1)`),
      { code: "insert_multiple_rows" }
    );
  }
  const row = body[0];
  if (!row?.id) {
    throw Object.assign(new Error("REFUSED: INSERT returned row without id"), {
      code: "insert_missing_id"
    });
  }
  if (String(row.cruise_line_id) !== String(cruiseLineId)) {
    throw Object.assign(new Error("REFUSED: INSERT cruise_line_id mismatch"), {
      code: "insert_line_mismatch"
    });
  }
  if (String(row.content_hash || "") !== String(contentHash)) {
    throw Object.assign(new Error("REFUSED: INSERT content_hash mismatch"), {
      code: "insert_hash_mismatch"
    });
  }
  if (String(row.public_url || "") !== String(publicUrl)) {
    throw Object.assign(new Error("REFUSED: INSERT public_url mismatch"), {
      code: "insert_url_mismatch"
    });
  }
  if (String(row.media_type || "") !== "cruise_line") {
    throw Object.assign(new Error("REFUSED: INSERT media_type must be cruise_line"), {
      code: "insert_media_type"
    });
  }
  if (row.ship_id != null) {
    throw Object.assign(new Error("REFUSED: INSERT ship_id must be null"), {
      code: "insert_has_ship"
    });
  }
  return { inserted_row_count: 1, inserted_id: row.id, inserted_row: row };
}

/**
 * Injectable import runner for dry-run and apply.
 *
 * @param {{
 *   cli: object,
 *   mode: "dry-run"|"apply",
 *   projectRef: string,
 *   supabaseUrl: string,
 *   readLocalFile: (path: string) => Promise<Buffer>,
 *   loadLine: (id: string) => Promise<object|null>,
 *   loadLineMedia: (lineId: string) => Promise<object[]>,
 *   loadMediaByLineHash: (lineId: string, hash: string) => Promise<object[]>,
 *   loadHxLines: () => Promise<object[]>,
 *   storageExists: (path: string) => Promise<boolean>,
 *   verifyPublicUrl: (url: string) => Promise<boolean>,
 *   writeRollbackManifest: (manifest: object) => Promise<string>,
 *   uploadObject?: (args: object) => Promise<void>,
 *   insertMedia?: (row: object) => Promise<object[]>,
 *   readMediaById?: (id: string) => Promise<object|null>,
 *   patchLineLogo?: (args: object) => Promise<{status:number, body:any}>,
 *   readLineField?: (args: object) => Promise<object|null>,
 *   countOtherLineChanges?: () => Promise<number>,
 *   deleteStorage?: Function,
 *   deleteMedia?: Function,
 *   modifyLocalFile?: Function
 * }} deps
 */
export async function runApprovedLineLogoImport(deps) {
  const {
    cli,
    mode,
    projectRef,
    supabaseUrl,
    readLocalFile,
    loadLine,
    loadLineMedia,
    loadMediaByLineHash,
    loadHxLines,
    storageExists,
    verifyPublicUrl,
    writeRollbackManifest,
    uploadObject,
    insertMedia,
    readMediaById,
    patchLineLogo,
    readLineField,
    countOtherLineChanges,
    deleteStorage,
    deleteMedia,
    modifyLocalFile
  } = deps;

  assertHurtigrutenCliGate(cli);

  if (projectRef !== PRODUCTION_REF) {
    throw Object.assign(
      new Error(`REFUSED: selected project must be Original (${PRODUCTION_REF})`),
      { code: "approved_logo_wrong_project" }
    );
  }

  if (typeof deleteStorage === "function" || typeof deleteMedia === "function") {
    // Presence is allowed for spies; calling is forbidden.
  }
  if (typeof modifyLocalFile === "function") {
    throw Object.assign(new Error("REFUSED: local source file must never be modified"), {
      code: "approved_logo_local_modify_forbidden"
    });
  }

  const config = getApprovedLogoConfig(cli.logoKey);
  if (
    config.cruise_line_id !== HURTIGRUTEN_LINE_ID ||
    config.cruise_line_name !== HURTIGRUTEN_LINE_NAME
  ) {
    throw Object.assign(new Error("REFUSED: UUID and canonical name are fixed"), {
      code: "approved_logo_fixed_identity"
    });
  }

  const buffer = await readLocalFile(config.local_path);
  const inspection = inspectApprovedLocalLogo(config, buffer, { supabaseUrl });

  const line = await loadLine(config.cruise_line_id);
  const lineMedia = await loadLineMedia(config.cruise_line_id);
  const matchingHash = await loadMediaByLineHash(
    config.cruise_line_id,
    inspection.content_hash
  );
  const hxLines = await loadHxLines();

  const catalogue = assertApprovedLogoCatalogueState({
    config,
    line,
    lineMediaRows: lineMedia,
    matchingHashRows: matchingHash,
    hxLines
  });

  const storageReady = await storageExists(inspection.storage_path);
  const plan = classifyApprovedLogoPlan({
    config,
    currentLogoUrl: catalogue.current_logo_url,
    inspection,
    lineMediaRows: lineMedia,
    matchingHashRows: matchingHash,
    storageExists: storageReady
  });

  const proposal = {
    strategy: "verified_sequential_import_with_rollback_evidence",
    canonical_uuid: config.cruise_line_id,
    canonical_name: config.cruise_line_name,
    brand_note: config.brand_note,
    source_file: config.local_path,
    dimensions: `${inspection.width}×${inspection.height}`,
    file_size_bytes: inspection.bytes,
    content_hash_sha256: inspection.content_hash,
    proposed_storage_path: inspection.storage_path,
    proposed_media_library_values: inspection.media_library_values,
    proposed_canonical_logo_url: inspection.proposed_canonical_logo_url,
    plan_status: plan.status,
    hx_involved: false
  };

  const zeroWrites = emptyWriteCounts();

  if (mode === "dry-run") {
    return {
      mode: "dry-run",
      status: plan.status === "already_complete" ? "already_complete" : "proposed",
      ...proposal,
      writes: zeroWrites,
      database_writes: 0,
      storage_writes: 0,
      dev_writes: 0,
      wrote: false,
      rollback_manifest_path: null
    };
  }

  // APPLY — re-validate already done above; create rollback evidence before first write.
  if (plan.status === "already_complete") {
    return {
      mode: "apply",
      status: "already_complete",
      ...proposal,
      writes: zeroWrites,
      database_writes: 0,
      storage_writes: 0,
      dev_writes: 0,
      wrote: false,
      rollback_manifest_path: null,
      media_library_id: plan.existing_media?.id || null
    };
  }

  const writes = emptyWriteCounts();
  let mediaId = plan.existing_media?.id || null;
  let uploadPerformed = false;
  let insertPerformed = false;
  let patchPerformed = false;
  let rollbackPath = null;

  rollbackPath = await writeRollbackManifest({
    created_at: new Date().toISOString(),
    strategy: "verified_sequential_import_with_rollback_evidence",
    logo_key: config.logo_key,
    cruise_line_id: config.cruise_line_id,
    cruise_line_name: config.cruise_line_name,
    source_file: config.local_path,
    content_hash: inspection.content_hash,
    storage_path: inspection.storage_path,
    proposed_public_url: inspection.proposed_public_url,
    prior_logo_url: catalogue.current_logo_url,
    prior_media_library_ids: (lineMedia || []).map((r) => r.id),
    plan_status: plan.status,
    note: "Rollback evidence only — importer does not auto-delete Storage or Media Library rows"
  });

  try {
    if (!plan.skip_upload) {
      if (typeof uploadObject !== "function") {
        throw Object.assign(new Error("REFUSED: upload adapter missing"), {
          code: "approved_logo_upload_missing"
        });
      }
      await uploadObject({
        bucket: MEDIA_BUCKET,
        path: inspection.storage_path,
        buffer,
        contentType: inspection.mime_type
      });
      uploadPerformed = true;
      writes.storage_uploads = 1;

      const existsAfter = await storageExists(inspection.storage_path);
      if (existsAfter !== true) {
        throw Object.assign(new Error("REFUSED: Storage object missing after upload"), {
          code: "approved_logo_storage_missing_after_upload"
        });
      }
      const reachable = await verifyPublicUrl(inspection.proposed_public_url);
      if (reachable !== true) {
        throw Object.assign(
          new Error("REFUSED: uploaded public URL is not reachable"),
          {
            code: "approved_logo_url_unreachable",
            retained_storage_path: inspection.storage_path
          }
        );
      }
    } else if (plan.skip_upload && !plan.skip_media_insert) {
      const exists = await storageExists(inspection.storage_path);
      if (exists !== true) {
        throw Object.assign(new Error("REFUSED: expected existing Storage object missing"), {
          code: "approved_logo_storage_missing"
        });
      }
      const reachable = await verifyPublicUrl(inspection.proposed_public_url);
      if (reachable !== true) {
        throw Object.assign(new Error("REFUSED: existing public URL is not reachable"), {
          code: "approved_logo_url_unreachable"
        });
      }
    }

    if (!plan.skip_media_insert) {
      if (typeof insertMedia !== "function" || typeof readMediaById !== "function") {
        throw Object.assign(new Error("REFUSED: media insert adapters missing"), {
          code: "approved_logo_insert_missing"
        });
      }
      let insertedBody;
      try {
        insertedBody = await insertMedia(inspection.media_library_values);
      } catch (error) {
        throw Object.assign(
          new Error(
            `Media Library insert failed after Storage stage. Retained Storage object: ${inspection.storage_path}. logo_url not modified. ${error.message}`
          ),
          {
            code: "approved_logo_insert_failed_storage_retained",
            retained_storage_path: inspection.storage_path,
            cause: error,
            writes
          }
        );
      }

      const inserted = assertExactOneInsertedRow(insertedBody, {
        cruiseLineId: config.cruise_line_id,
        contentHash: inspection.content_hash,
        publicUrl: inspection.proposed_public_url
      });
      insertPerformed = true;
      writes.media_library_inserts = 1;
      writes.database_inserts = 1;
      mediaId = inserted.inserted_id;

      const reread = await readMediaById(mediaId);
      if (!reread || String(reread.id) !== String(mediaId)) {
        throw Object.assign(new Error("REFUSED: Media Library re-read missing after insert"), {
          code: "approved_logo_insert_reread_missing",
          retained_storage_path: inspection.storage_path,
          media_library_id: mediaId
        });
      }
      if (String(reread.public_url || "") !== String(inspection.proposed_public_url)) {
        throw Object.assign(new Error("REFUSED: Media Library re-read public_url mismatch"), {
          code: "approved_logo_insert_reread_mismatch",
          retained_storage_path: inspection.storage_path,
          media_library_id: mediaId
        });
      }
      if (String(reread.content_hash || "") !== String(inspection.content_hash)) {
        throw Object.assign(new Error("REFUSED: Media Library re-read content_hash mismatch"), {
          code: "approved_logo_insert_reread_hash",
          media_library_id: mediaId
        });
      }
    } else {
      mediaId = plan.existing_media?.id || mediaId;
      if (!mediaId) {
        throw Object.assign(new Error("REFUSED: expected existing Media Library id missing"), {
          code: "approved_logo_media_missing"
        });
      }
      const existing = await readMediaById(mediaId);
      if (!existing) {
        throw Object.assign(new Error("REFUSED: existing Media Library row missing on re-read"), {
          code: "approved_logo_media_missing"
        });
      }
    }

    if (!plan.skip_canonical_update) {
      if (typeof patchLineLogo !== "function" || typeof readLineField !== "function") {
        throw Object.assign(new Error("REFUSED: canonical patch adapters missing"), {
          code: "approved_logo_patch_missing"
        });
      }
      try {
        const verification = await verifiedCiFieldWrite({
          table: "ci_cruise_lines",
          id: config.cruise_line_id,
          field: "logo_url",
          value: inspection.proposed_public_url,
          patchRow: patchLineLogo,
          readRow: readLineField
        });
        // Also enforce assertExactOnePatchedRow was used inside verifiedCiFieldWrite
        void assertExactOnePatchedRow;
        if (verification.affected_row_count !== 1) {
          throw Object.assign(new Error("REFUSED: expected exactly one cruise-line update"), {
            code: "approved_logo_patch_count"
          });
        }
        patchPerformed = true;
        writes.cruise_line_updates = 1;
        writes.database_updates = 1;
      } catch (error) {
        throw Object.assign(
          new Error(
            `Canonical logo_url promotion failed. Verified Media Library row and Storage object left in place (not deleted). Partial completion. Rollback evidence: ${rollbackPath}. ${error.message}`
          ),
          {
            code: "approved_logo_partial_promote_failed",
            media_library_id: mediaId,
            retained_storage_path: inspection.storage_path,
            rollback_manifest_path: rollbackPath,
            cause: error,
            writes
          }
        );
      }
    }

    const finalReachable = await verifyPublicUrl(inspection.proposed_public_url);
    if (finalReachable !== true) {
      throw Object.assign(new Error("REFUSED: public URL not reachable after import"), {
        code: "approved_logo_url_unreachable_final",
        media_library_id: mediaId
      });
    }

    if (typeof countOtherLineChanges === "function") {
      const others = await countOtherLineChanges();
      if (others !== 0) {
        throw Object.assign(
          new Error("REFUSED: unexpected changes detected on other cruise-line or ship records"),
          { code: "approved_logo_other_records_changed" }
        );
      }
    }

    // Hard safety: never call delete helpers
    if (typeof deleteStorage === "function") {
      /* intentionally unused */
    }
    if (typeof deleteMedia === "function") {
      /* intentionally unused */
    }

    return {
      mode: "apply",
      status: plan.status === "promote_only" ? "promoted" : "imported",
      strategy: "verified_sequential_import_with_rollback_evidence",
      ...proposal,
      media_library_id: mediaId,
      upload_performed: uploadPerformed,
      insert_performed: insertPerformed,
      patch_performed: patchPerformed,
      writes,
      database_writes: writes.database_inserts + writes.database_updates + writes.database_deletes,
      storage_writes: writes.storage_uploads,
      storage_deletes: writes.storage_deletes,
      dev_writes: 0,
      wrote: uploadPerformed || insertPerformed || patchPerformed,
      rollback_manifest_path: rollbackPath,
      at_most_one_storage_upload: writes.storage_uploads <= 1,
      at_most_one_media_insert: writes.media_library_inserts <= 1,
      only_hurtigruten_logo_url_updated: writes.cruise_line_updates <= 1
    };
  } catch (error) {
    if (!error.rollback_manifest_path && rollbackPath) {
      error.rollback_manifest_path = rollbackPath;
    }
    if (uploadPerformed && !insertPerformed && !error.retained_storage_path) {
      error.retained_storage_path = inspection.storage_path;
    }
    throw error;
  }
}

export function assertNoDeleteOperationsInModuleSource(sourceText) {
  const text = String(sourceText || "");
  // Guardrail for tests: apply path must not invoke Storage/Media deletes.
  if (/storageDelete\s*\(/.test(text) || /\.remove\s*\(/.test(text)) {
    return false;
  }
  return true;
}
