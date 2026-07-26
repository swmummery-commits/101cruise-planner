/**
 * Read-only contract for local Brand Imaging ship-image audit.
 * No DB/Storage/local-file write helpers are exported.
 */

export {
  AUDIT_ALLOWED_HTTP_METHODS,
  AUDIT_FORBIDDEN_HTTP_METHODS,
  AUDIT_FORBIDDEN_EXPORT_NAMES,
  assertAuditHttpMethod
} from "../media-coverage-audit/read-only.js";

/** Additional forbidden export names for this audit surface. */
export const LOCAL_SHIP_AUDIT_FORBIDDEN_EXPORT_NAMES = Object.freeze([
  "uploadObject",
  "insertMedia",
  "deleteObject",
  "supabaseWrite",
  "patchRow",
  "insertRow",
  "deleteRow",
  "promote",
  "copy",
  "writeLocalFile",
  "renameLocalFile",
  "deleteLocalFile",
  "convertLocalFile",
  "resizeLocalFile"
]);
