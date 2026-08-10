#!/usr/bin/env node
/**
 * Regression tests for Princess ECR12A rollback verification semantics.
 *   node scripts/test-princess-ecr12a-verification.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const audit = require(path.join(root, "netlify/functions/lib/princess-ecr12a-rollback-audit.js"));

const {
  STRAY_INSERT_MANIFEST_ID,
  ROLLED_BACK_ECR12A_RECORD_IDS,
  ROLLED_BACK_ECR12A_SAILING_IDS,
  auditEcr12aRollbackState,
  buildApprovedPrincessInsertIndex
} = audit;

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const rolledBackId = ROLLED_BACK_ECR12A_RECORD_IDS[0];
const rolledBackSailing = ROLLED_BACK_ECR12A_SAILING_IDS[0];
const legitimateId = "ed5e47a9-42d8-4638-816c-0fa284035785";
const approvedManifestId = "17dd52af-da1c-4d55-bf8e-330db9767beb";
const approvedRunId = "princess-session-batch-1-apply-2026-08-08T06-14-12-967Z";

function sampleManifests(extra = []) {
  return [
    {
      id: STRAY_INSERT_MANIFEST_ID,
      run_id: "princess-controlled-apply-2026-08-07T00-20-28-582Z",
      created_at: "2026-08-07T00:20:40.268046+00:00",
      manifest: {
        stats: {
          write_details: ROLLED_BACK_ECR12A_RECORD_IDS.map((id, i) => ({
            created: true,
            result_action: "inserted",
            princess_sailing_id: ROLLED_BACK_ECR12A_SAILING_IDS[i],
            discovered_cruise_id: id
          }))
        }
      }
    },
    ...extra
  ];
}

test("1. Rolled-back record ID still active => FAIL", () => {
  const result = auditEcr12aRollbackState({
    activeRows: [{ id: rolledBackId, official_sailing_id: rolledBackSailing, status: "active" }],
    manifestRows: sampleManifests()
  });
  if (!result.issues.some((i) => i.issue === "rolled_back_ecr12a_record_still_active")) {
    throw new Error("expected rolled_back_ecr12a_record_still_active");
  }
});

test("2. Rolled-back record absent => PASS", () => {
  const result = auditEcr12aRollbackState({
    activeRows: [],
    manifestRows: sampleManifests()
  });
  if (result.issues.length) throw new Error(JSON.stringify(result.issues));
});

test("3. Same sailing ID later legitimately inserted as new record ID => PASS", () => {
  const manifests = sampleManifests([
    {
      id: approvedManifestId,
      run_id: approvedRunId,
      created_at: "2026-08-08T06:14:57.714307+00:00",
      manifest: {
        stats: {
          write_details: [
            {
              created: true,
              result_action: "inserted",
              princess_sailing_id: rolledBackSailing,
              discovered_cruise_id: legitimateId
            }
          ]
        }
      }
    }
  ]);
  const result = auditEcr12aRollbackState({
    activeRows: [{ id: legitimateId, official_sailing_id: rolledBackSailing, status: "active" }],
    manifestRows: manifests
  });
  if (result.issues.length) throw new Error(JSON.stringify(result.issues));
  if (result.legitimate_reinsertions !== 1) throw new Error("expected one legitimate reinsertion note");
});

test("4. Same official_sailing_id appears twice active => duplicate handled separately", () => {
  const result = auditEcr12aRollbackState({
    activeRows: [
      { id: legitimateId, official_sailing_id: rolledBackSailing, status: "active" },
      { id: "another-new-id", official_sailing_id: rolledBackSailing, status: "active" }
    ],
    manifestRows: sampleManifests([
      {
        id: approvedManifestId,
        run_id: approvedRunId,
        manifest: {
          stats: {
            write_details: [
              {
                created: true,
                result_action: "inserted",
                princess_sailing_id: rolledBackSailing,
                discovered_cruise_id: legitimateId
              }
            ]
          }
        }
      }
    ])
  });
  const untracked = result.issues.filter((i) => i.issue === "ecr12a_untracked_reinsertion");
  if (untracked.length !== 1 || untracked[0].id !== "another-new-id") {
    throw new Error("expected untracked duplicate identity recreation");
  }
});

test("5. Historical stray insert manifest preserved in audit constants", () => {
  if (STRAY_INSERT_MANIFEST_ID !== "e8fb8e5f-0d09-49c6-ba84-1456b6ee29d6") {
    throw new Error("stray manifest id changed");
  }
  if (ROLLED_BACK_ECR12A_RECORD_IDS.length !== 9) throw new Error("expected 9 ECR12A record ids");
});

test("6. Legitimate reinsertion requires later manifest trail", () => {
  const result = auditEcr12aRollbackState({
    activeRows: [{ id: legitimateId, official_sailing_id: rolledBackSailing, status: "active" }],
    manifestRows: sampleManifests()
  });
  if (!result.issues.some((i) => i.issue === "ecr12a_untracked_reinsertion")) {
    throw new Error("expected untracked reinsertion without manifest");
  }
});

test("7. Unknown recreation of rolled-back identity => FAIL", () => {
  const result = auditEcr12aRollbackState({
    activeRows: [{ id: "00000000-0000-4000-8000-000000000099", official_sailing_id: rolledBackSailing, status: "active" }],
    manifestRows: sampleManifests()
  });
  if (!result.issues.some((i) => i.issue === "ecr12a_untracked_reinsertion")) {
    throw new Error("expected review/fail for unknown recreation");
  }
});

test("8. Current 9 ECR12A production records pass with session batch-1 manifest", () => {
  const currentIds = [
    "ed5e47a9-42d8-4638-816c-0fa284035785",
    "7f284838-b955-4be5-9933-3ff808829a3f",
    "184fa268-0356-48fe-8862-5129106c29d9",
    "a378f6d1-e3b2-4ef9-bf42-206d8efdc1e1",
    "056cb93f-483a-4f9f-8cbc-4d27a3e7420b",
    "0930ae7e-3a34-42f3-ab6b-f36f293c2cb5",
    "e3d08b61-f274-4c04-80c2-341738966ace",
    "7d825bea-7362-4b93-bf0e-4fd18562488a",
    "f8ca3b4c-5805-47a7-a555-edc7dce818da"
  ];
  const writeDetails = currentIds.map((id, i) => ({
    created: true,
    result_action: "inserted",
    princess_sailing_id: ROLLED_BACK_ECR12A_SAILING_IDS[i],
    discovered_cruise_id: id
  }));
  const manifests = sampleManifests([
    {
      id: approvedManifestId,
      run_id: approvedRunId,
      manifest: { stats: { write_details: writeDetails } }
    }
  ]);
  const activeRows = currentIds.map((id, i) => ({
    id,
    official_sailing_id: ROLLED_BACK_ECR12A_SAILING_IDS[i],
    status: "active"
  }));
  const result = auditEcr12aRollbackState({ activeRows, manifestRows: manifests });
  if (result.issues.length) throw new Error(JSON.stringify(result.issues));
  if (result.legitimate_reinsertions !== 9) throw new Error("expected 9 legitimate reinsertions");
});

test("9. Stray batch IDs excluded from approved insert index", () => {
  const index = buildApprovedPrincessInsertIndex(sampleManifests());
  for (const id of ROLLED_BACK_ECR12A_RECORD_IDS) {
    if (index.has(id)) throw new Error("stray batch id must not be approved");
  }
});

test("10. Verify script uses record-based audit not sailing prefix blacklist", () => {
  const verifySrc = fs.readFileSync(path.join(root, "scripts/verify-princess-production-records.mjs"), "utf8");
  if (verifySrc.includes('startsWith("ECR12A|CB|")') && verifySrc.includes("rolled_back_ecr12a_present")) {
    throw new Error("verifier still uses permanent sailing-id blacklist");
  }
  if (!verifySrc.includes("auditEcr12aRollbackState")) throw new Error("verifier must call auditEcr12aRollbackState");
});

console.log(`\ntest-princess-ecr12a-verification: ${passed} passed`);
