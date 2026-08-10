/**
 * ECR12A parallel-batch incident audit (2026-08-07).
 *
 * A duplicate `run-princess-first-production-batch.mjs --apply` inserted 20 records
 * (9 × ECR12A|CB|… + 11 × ASG070|RP|…) before the intended controlled batch.
 * Manifest e8fb8e5f documents that stray insert; those record IDs were rolled back.
 *
 * The same official sailing identities may legitimately reappear via later approved
 * catch-up batches with new discovered_cruise IDs. Verification must distinguish
 * rolled-back record IDs from later approved reinsertions — not blacklist sailing IDs.
 */

/** @type {const} */
const STRAY_INSERT_MANIFEST_ID = "e8fb8e5f-0d09-49c6-ba84-1456b6ee29d6";

/** @type {const} */
const STRAY_INSERT_RUN_ID = "princess-controlled-apply-2026-08-07T00-20-28-582Z";

/** Record IDs from the stray batch that were rolled back (all 20 inserts). */
const STRAY_BATCH_ROLLED_BACK_RECORD_IDS = Object.freeze([
  "f8930802-e9d9-47ce-8e0c-c234898b7131",
  "187c7f1e-fde5-4b1c-8ce7-de91bb500fb8",
  "656c64e3-4c7d-45b0-98a7-ded1748a7827",
  "6a5f5a48-db35-4c8d-8164-4c551226135b",
  "f2f90f27-d44f-4a71-a085-ec235e4d6119",
  "5b5c5a5e-205f-4763-9003-312b50a39669",
  "2e48dc21-72b3-4671-bf91-0e70c196c8a8",
  "cba88c02-67aa-4323-9b76-e48e008579f2",
  "7f7d2231-fd75-4409-91d8-51f64500dfde",
  "b3510e96-d541-4d83-9f8c-4e7530c8d137",
  "8c50513d-70c2-4398-96bc-4814b61a7b87",
  "19b3b2c0-585f-4746-8de3-415a9357f57d",
  "3cbb3e82-f01e-4540-8211-18eabf124e5e",
  "eee3402c-c0c6-47c9-9563-d2fc0976f26a",
  "87ac7f89-19ce-4892-a713-0ee864e16657",
  "9d9c4131-d705-4103-9ad4-d51724fb1026",
  "09f7500f-dd59-4559-9a07-c5d4883d949b",
  "b2930cef-89c1-428a-bf86-a8f8887eeb34",
  "594b19d6-6571-49b9-8bda-4f26812a65af",
  "1f130675-a8f4-426d-b5dc-69c66007d4b1"
]);

/** ECR12A|CB subset of the stray batch (9 sailings). */
const ROLLED_BACK_ECR12A_RECORD_IDS = Object.freeze([
  "f8930802-e9d9-47ce-8e0c-c234898b7131",
  "187c7f1e-fde5-4b1c-8ce7-de91bb500fb8",
  "656c64e3-4c7d-45b0-98a7-ded1748a7827",
  "6a5f5a48-db35-4c8d-8164-4c551226135b",
  "f2f90f27-d44f-4a71-a085-ec235e4d6119",
  "5b5c5a5e-205f-4763-9003-312b50a39669",
  "2e48dc21-72b3-4671-bf91-0e70c196c8a8",
  "cba88c02-67aa-4323-9b76-e48e008579f2",
  "7f7d2231-fd75-4409-91d8-51f64500dfde"
]);

/** Official sailing identities rolled back with the stray ECR12A batch. */
const ROLLED_BACK_ECR12A_SAILING_IDS = Object.freeze([
  "ECR12A|CB|2027-05-06",
  "ECR12A|CB|2027-05-18",
  "ECR12A|CB|2027-05-30",
  "ECR12A|CB|2027-06-11",
  "ECR12A|CB|2027-06-23",
  "ECR12A|CB|2027-07-05",
  "ECR12A|CB|2027-07-17",
  "ECR12A|CB|2027-07-29",
  "ECR12A|CB|2027-08-10"
]);

const strayRecordIdSet = new Set(STRAY_BATCH_ROLLED_BACK_RECORD_IDS);
const rolledBackEcr12aRecordIdSet = new Set(ROLLED_BACK_ECR12A_RECORD_IDS);
const rolledBackEcr12aSailingIdSet = new Set(ROLLED_BACK_ECR12A_SAILING_IDS);

function sailingIdFromDetail(detail) {
  return (
    detail?.official_sailing_id ||
    detail?.princess_sailing_id ||
    detail?.hal_product_key ||
    detail?.celebrity_sailing_id ||
    null
  );
}

function isInsertDetail(detail) {
  return Boolean(
    detail?.discovered_cruise_id &&
      (detail.created ||
        detail.result_action === "inserted" ||
        detail.recovered_after_fetch_failure ||
        detail.action === "insert")
  );
}

function extractManifestWriteDetails(manifestRow) {
  const manifest = manifestRow?.manifest || manifestRow;
  const fromStats = manifest?.stats?.write_details;
  if (Array.isArray(fromStats) && fromStats.length) return fromStats;
  const inserted = manifest?.inserted;
  if (Array.isArray(inserted) && inserted.length) {
    return inserted.map((entry) => ({
      discovered_cruise_id: entry.discovered_cruise_id,
      official_sailing_id: entry.official_sailing_id,
      created: entry.action === "insert",
      result_action: entry.action === "insert" ? "inserted" : entry.action
    }));
  }
  return [];
}

/**
 * Build index of record IDs inserted by approved manifests (excluding the stray batch).
 * @param {Array<{ id?: string, run_id?: string, created_at?: string, manifest?: object }>} manifestRows
 */
function buildApprovedPrincessInsertIndex(manifestRows) {
  const index = new Map();
  for (const row of manifestRows || []) {
    if (!row?.id || row.id === STRAY_INSERT_MANIFEST_ID) continue;
    for (const detail of extractManifestWriteDetails(row)) {
      if (!isInsertDetail(detail)) continue;
      const recordId = detail.discovered_cruise_id;
      if (!recordId || strayRecordIdSet.has(recordId)) continue;
      index.set(recordId, {
        manifest_id: row.id,
        run_id: row.run_id || row.manifest?.run_id || null,
        official_sailing_id: sailingIdFromDetail(detail),
        manifest_created_at: row.created_at || null
      });
    }
  }
  return index;
}

/**
 * Audit active Princess rows against the ECR12A rollback incident.
 *
 * @param {{ activeRows: object[], manifestRows?: object[] }} params
 */
function auditEcr12aRollbackState({ activeRows, manifestRows = [] }) {
  const approvedInserts = buildApprovedPrincessInsertIndex(manifestRows);
  const issues = [];
  const reinsertionNotes = [];

  for (const row of activeRows || []) {
    const recordId = row.id;
    const sailingId = String(row.official_sailing_id || "");

    if (rolledBackEcr12aRecordIdSet.has(recordId)) {
      issues.push({
        issue: "rolled_back_ecr12a_record_still_active",
        id: recordId,
        official_sailing_id: sailingId
      });
      continue;
    }

    if (!sailingId.startsWith("ECR12A|CB|")) continue;

    const approval = approvedInserts.get(recordId);
    if (rolledBackEcr12aSailingIdSet.has(sailingId)) {
      if (approval) {
        reinsertionNotes.push({
          id: recordId,
          official_sailing_id: sailingId,
          historically_rolled_back: true,
          later_legitimately_reinserted: true,
          approved_manifest_id: approval.manifest_id,
          approved_run_id: approval.run_id
        });
      } else {
        issues.push({
          issue: "ecr12a_untracked_reinsertion",
          id: recordId,
          official_sailing_id: sailingId,
          note: "Sailing identity was rolled back; active record lacks approved manifest trail"
        });
      }
    }
  }

  const ecr12aActive = (activeRows || []).filter((row) =>
    String(row.official_sailing_id || "").startsWith("ECR12A|CB|")
  );

  return {
    issues,
    reinsertion_notes: reinsertionNotes,
    ecr12a_active_count: ecr12aActive.length,
    rolled_back_record_ids_still_active: issues.filter(
      (i) => i.issue === "rolled_back_ecr12a_record_still_active"
    ).length,
    untracked_reinsertions: issues.filter((i) => i.issue === "ecr12a_untracked_reinsertion").length,
    legitimate_reinsertions: reinsertionNotes.length,
    stray_insert_manifest_id: STRAY_INSERT_MANIFEST_ID,
    stray_insert_run_id: STRAY_INSERT_RUN_ID
  };
}

module.exports = {
  STRAY_INSERT_MANIFEST_ID,
  STRAY_INSERT_RUN_ID,
  STRAY_BATCH_ROLLED_BACK_RECORD_IDS,
  ROLLED_BACK_ECR12A_RECORD_IDS,
  ROLLED_BACK_ECR12A_SAILING_IDS,
  buildApprovedPrincessInsertIndex,
  auditEcr12aRollbackState
};
