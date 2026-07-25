/**
 * Verified CI field PATCH helpers for Original-project promote/repair.
 * PostgREST may return HTTP 200 with [] when zero rows match — never treat
 * response.ok alone as success.
 */

/**
 * Validate Prefer: return=representation body for a single-row PATCH.
 */
export function assertExactOnePatchedRow(body, { entityUuid, field, expectedValue }) {
  if (!Array.isArray(body)) {
    throw Object.assign(new Error("REFUSED: PATCH representation must be a JSON array"), {
      code: "patch_invalid_representation"
    });
  }
  if (body.length === 0) {
    throw Object.assign(new Error("REFUSED: PATCH matched zero rows"), {
      code: "patch_zero_rows"
    });
  }
  if (body.length > 1) {
    throw Object.assign(
      new Error(`REFUSED: PATCH matched ${body.length} rows (expected exactly 1)`),
      { code: "patch_multiple_rows" }
    );
  }
  const row = body[0];
  if (String(row?.id) !== String(entityUuid)) {
    throw Object.assign(
      new Error(
        `REFUSED: PATCH returned wrong UUID (expected ${entityUuid}, got ${row?.id ?? "(missing)"})`
      ),
      { code: "patch_wrong_uuid" }
    );
  }
  if (String(row?.[field] ?? "") !== String(expectedValue ?? "")) {
    throw Object.assign(
      new Error(`REFUSED: PATCH returned wrong ${field} value`),
      { code: "patch_wrong_field_value" }
    );
  }
  return {
    affected_row_count: 1,
    returned_entity_uuid: row.id,
    returned_field_value: row[field]
  };
}

/**
 * PATCH + representation checks + re-read confirmation.
 *
 * @param {{
 *   table: string,
 *   id: string,
 *   field: string,
 *   value: string,
 *   patchRow: (args: {table:string,id:string,field:string,value:string}) => Promise<{status:number, body:any}>,
 *   readRow: (args: {table:string,id:string,field:string}) => Promise<object|null>
 * }} opts
 */
export async function verifiedCiFieldWrite({ table, id, field, value, patchRow, readRow }) {
  const { status, body } = await patchRow({ table, id, field, value });
  if (!(status >= 200 && status < 300)) {
    throw Object.assign(new Error(`REFUSED: PATCH HTTP ${status}`), {
      code: "patch_http_error",
      http_status: status
    });
  }

  let patchCheck;
  try {
    patchCheck = assertExactOnePatchedRow(body, {
      entityUuid: id,
      field,
      expectedValue: value
    });
  } catch (error) {
    error.http_status = status;
    error.patch_body = body;
    throw error;
  }

  const reread = await readRow({ table, id, field });
  if (!reread) {
    throw Object.assign(new Error("REFUSED: post-write re-read found no row"), {
      code: "post_write_reread_missing",
      http_status: status,
      ...patchCheck,
      post_write_verification: "missing_row"
    });
  }
  if (String(reread.id) !== String(id)) {
    throw Object.assign(new Error("REFUSED: post-write re-read returned wrong UUID"), {
      code: "post_write_wrong_uuid",
      http_status: status,
      ...patchCheck,
      post_write_verification: "wrong_uuid"
    });
  }
  if (String(reread[field] ?? "") !== String(value ?? "")) {
    throw Object.assign(
      new Error(`REFUSED: post-write re-read ${field} does not match intended value`),
      {
        code: "post_write_mismatch",
        http_status: status,
        ...patchCheck,
        post_write_verification: "mismatch",
        persisted_value: reread[field] ?? null
      }
    );
  }

  return {
    http_status: status,
    affected_row_count: patchCheck.affected_row_count,
    returned_entity_uuid: patchCheck.returned_entity_uuid,
    returned_field_value: patchCheck.returned_field_value,
    post_write_verification: "ok",
    persisted_value: reread[field]
  };
}

/**
 * Verified sequential updates with compensating rollback (not a DB transaction).
 */
export async function applyVerifiedSequentialUpdates(
  updates,
  { verifiedWrite, failureLabel = "UPDATE", rolledBackCode = "production_promote_rolled_back" } = {}
) {
  const applied = [];
  try {
    for (const u of updates) {
      const verification = await verifiedWrite({
        table: u.table,
        id: u.entity_uuid,
        field: u.field,
        value: u.new_url
      });
      applied.push({ update: u, verification });
    }
    return {
      ok: true,
      strategy: "verified_sequential_update_with_compensating_rollback",
      applied,
      restored: []
    };
  } catch (error) {
    const restored = [];
    for (const entry of [...applied].reverse()) {
      const u = entry.update;
      try {
        const rollbackVerification = await verifiedWrite({
          table: u.table,
          id: u.entity_uuid,
          field: u.field,
          value: u.original_url
        });
        restored.push({
          update: u,
          rollback_verification: rollbackVerification
        });
      } catch (restoreError) {
        throw Object.assign(
          new Error(
            `COMPENSATING ROLLBACK FAILED for ${u.table}.${u.field}: ${restoreError.message}. Earlier error: ${error.message}`
          ),
          {
            code: "compensating_rollback_failed",
            cause: error,
            restore_error: restoreError,
            restored,
            applied
          }
        );
      }
    }
    throw Object.assign(
      new Error(
        `${failureLabel} FAILED — compensating rollback restored ${restored.length} field(s). Original error: ${error.message}`
      ),
      {
        code: rolledBackCode,
        cause: error,
        restored,
        applied
      }
    );
  }
}
