/**
 * Read-only contract for Cruise Media Coverage Audit.
 * No INSERT/UPDATE/DELETE/Storage write helpers are exported.
 */

/** Only these HTTP methods may be used against Supabase REST or Storage. */
export const AUDIT_ALLOWED_HTTP_METHODS = Object.freeze(["GET", "HEAD"]);

/** Explicitly forbidden write methods (must never appear in audit HTTP layer). */
export const AUDIT_FORBIDDEN_HTTP_METHODS = Object.freeze([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "TRACE"
]);

/**
 * Guard for audit network calls. Throws if method is not GET/HEAD.
 * @param {string} method
 */
export function assertAuditHttpMethod(method) {
  const m = String(method || "").toUpperCase();
  if (!AUDIT_ALLOWED_HTTP_METHODS.includes(m)) {
    throw Object.assign(
      new Error(`REFUSED: media coverage audit is read-only (forbidden HTTP ${m})`),
      { code: "audit_write_forbidden" }
    );
  }
  return m;
}

/**
 * Symbols / names that must not be exported by the audit HTTP surface.
 */
export const AUDIT_FORBIDDEN_EXPORT_NAMES = Object.freeze([
  "uploadObject",
  "insertMedia",
  "deleteObject",
  "supabaseWrite",
  "patchRow",
  "insertRow",
  "deleteRow",
  "promote",
  "copy"
]);
