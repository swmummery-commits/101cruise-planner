/**
 * Disney PAVAS identity-set convergence.
 *
 * Consecutive snapshots do not have to be identical forever. Additive official
 * publication is allowed. Disappearing identities block catch-up.
 */

const crypto = require("crypto");
const { P2_CATCHUP_DISNEY_BATCH } = require("./disney-controlled-batch");

const DISNEY_CATCHUP_BATCH_CAP = P2_CATCHUP_DISNEY_BATCH;

function normaliseIdentity(value) {
  return String(value || "").trim();
}

function identityList(snapshot = {}) {
  const raw = snapshot.identities || snapshot.official_sailing_ids || snapshot.eligible_ids || [];
  return [...new Set((raw || []).map(normaliseIdentity).filter(Boolean))].sort();
}

function hashIdentitySet(snapshotOrIds) {
  const ids = Array.isArray(snapshotOrIds) ? [...new Set(snapshotOrIds.map(normaliseIdentity).filter(Boolean))].sort() : identityList(snapshotOrIds);
  return crypto.createHash("sha256").update(ids.join("\n")).digest("hex");
}

function compareIdentitySnapshots(previous = {}, next = {}) {
  const prev = new Set(identityList(previous));
  const nextIds = new Set(identityList(next));
  const added = [...nextIds].filter((id) => !prev.has(id)).sort();
  const removed = [...prev].filter((id) => !nextIds.has(id)).sort();
  const identical = added.length === 0 && removed.length === 0;
  let drift = "IDENTICAL";
  if (identical) drift = "IDENTICAL";
  else if (removed.length === 0 && added.length > 0) drift = "ADDITIVE_ONLY";
  else if (added.length === 0 && removed.length > 0) drift = "DISAPPEARING";
  else drift = "MIXED";
  return {
    previous_count: prev.size,
    next_count: nextIds.size,
    previous_hash: hashIdentitySet(previous),
    next_hash: hashIdentitySet(next),
    added,
    removed,
    identical,
    additive_only: drift === "ADDITIVE_ONLY",
    disappearing: removed.length > 0,
    drift
  };
}

function evaluateDisneySourceConvergence(snapshots = []) {
  const list = (snapshots || []).filter(Boolean);
  if (list.length < 2) {
    return {
      converged: false,
      classification: "INSUFFICIENT_SNAPSHOTS",
      frozen: null,
      catch_up_blocked: true,
      reason: "need_at_least_two_snapshots"
    };
  }
  const comparisons = [];
  for (let i = 1; i < list.length; i += 1) {
    comparisons.push(compareIdentitySnapshots(list[i - 1], list[i]));
  }
  if (comparisons.some((row) => row.disappearing)) {
    return {
      converged: false,
      classification: "SOURCE_REPAIR_REQUIRED",
      frozen: null,
      catch_up_blocked: true,
      reason: "identities_disappeared_between_snapshots",
      comparisons,
      max_catchup_batch: DISNEY_CATCHUP_BATCH_CAP
    };
  }
  const latest = list[list.length - 1];
  const lastCompare = comparisons[comparisons.length - 1];
  if (lastCompare.identical) {
    return {
      converged: true,
      classification: "CONVERGED",
      frozen: {
        identities: identityList(latest),
        hash: hashIdentitySet(latest),
        eligible: latest.eligible ?? identityList(latest).length
      },
      catch_up_blocked: false,
      reason: "latest_two_identity_sets_identical",
      comparisons,
      max_catchup_batch: DISNEY_CATCHUP_BATCH_CAP
    };
  }
  const allAdditive = comparisons.every((row) => row.identical || row.additive_only);
  if (list.length >= 3 && allAdditive) {
    return {
      converged: true,
      classification: "CONVERGED_ADDITIVE_PUBLICATION",
      frozen: {
        identities: identityList(latest),
        hash: hashIdentitySet(latest),
        eligible: latest.eligible ?? identityList(latest).length
      },
      catch_up_blocked: false,
      reason: "three_consecutive_additive_or_stable_snapshots",
      comparisons,
      max_catchup_batch: DISNEY_CATCHUP_BATCH_CAP
    };
  }
  return {
    converged: false,
    classification: "AWAITING_STABLE_SNAPSHOT",
    frozen: null,
    catch_up_blocked: true,
    reason: "additive_drift_requires_confirming_snapshot",
    comparisons,
    max_catchup_batch: DISNEY_CATCHUP_BATCH_CAP
  };
}

module.exports = {
  DISNEY_CATCHUP_BATCH_CAP,
  identityList,
  hashIdentitySet,
  compareIdentitySnapshots,
  evaluateDisneySourceConvergence
};
