/**
 * Cross-line weekly maintenance write accounting.
 *
 * A later failure must not erase earlier committed discovered_cruises writes.
 * Nested apply stats (writes_performed.inserted) flatten onto ledger fields
 * (inserts, enriched, promoted_active, failed_writes, inventory_changed).
 */

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function num(primary, fallback = 0) {
  const value = primary == null || primary === "" ? fallback : primary;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function flattenWeeklyWriteStats(summary = {}) {
  const writes = asObject(summary.writes_performed);
  const inserts = num(summary.inserts, writes.inserted);
  const updates = num(summary.updates, writes.updated);
  const enriched = num(summary.enriched, writes.enriched);
  const promotedActive = num(summary.promoted_active, writes.promoted_active);
  const cutoffHidden = num(summary.cutoff_hidden, writes.cutoff_hidden);
  const sourceAbsenceHidden = num(
    summary.source_absence_hidden ?? summary.source_absence_actions,
    writes.source_absence_hidden
  );
  const failedWrites = num(summary.failed_writes, writes.failed);
  const committed = inserts + updates + promotedActive + cutoffHidden + sourceAbsenceHidden;
  const writeAttempts =
    summary.write_attempts ??
    writes.write_attempts ??
    committed + failedWrites;

  return {
    inserts,
    updates,
    enriched,
    promoted_active: promotedActive,
    cutoff_hidden: cutoffHidden,
    source_absence_hidden: sourceAbsenceHidden,
    failed_writes: failedWrites,
    write_attempts: writeAttempts,
    committed_material_writes: committed,
    inventory_changed: summary.inventory_changed === true || committed > 0,
    rollback_manifest_id: summary.rollback_manifest_id || writes.rollback_manifest_id || null
  };
}

function mergeFlattenedWriteStats(summary = {}) {
  const flat = flattenWeeklyWriteStats(summary);
  return {
    ...summary,
    inserts: flat.inserts,
    updates: flat.updates,
    enriched: flat.enriched,
    promoted_active: flat.promoted_active,
    cutoff_hidden: flat.cutoff_hidden,
    source_absence_hidden: flat.source_absence_hidden,
    failed_writes: flat.failed_writes,
    write_attempts: flat.write_attempts,
    committed_material_writes: flat.committed_material_writes,
    inventory_changed: flat.inventory_changed,
    rollback_manifest_id: summary.rollback_manifest_id || flat.rollback_manifest_id
  };
}

function resolveWeeklyTerminalStatus({
  ok,
  blocked = false,
  review_required = false,
  already_running = false,
  reason = null,
  summary = {}
} = {}) {
  const flat = flattenWeeklyWriteStats(summary);
  if (already_running || reason === "maintenance_lock_held") return "completed";
  if (review_required) return "review_required";
  if (!ok && flat.committed_material_writes === 0) return "failed_before_writes";
  if (!ok && flat.committed_material_writes > 0) return "partial_write_failure";
  if (
    ok &&
    (summary.staged_match_required_inserts > 0 || summary.line_slug === "norwegian-cruise-line") &&
    flat.inserts > 0 &&
    flat.promoted_active === 0
  ) {
    return "completed_with_staged_rows";
  }
  if (ok) return "completed";
  if (blocked && flat.committed_material_writes === 0) return "failed_before_writes";
  return "failed_before_writes";
}

function resolveLedgerRunStatus(terminalStatus) {
  if (terminalStatus === "completed" || terminalStatus === "review_required") return "completed";
  if (terminalStatus === "completed_with_staged_rows") return "completed";
  return "failed";
}

module.exports = {
  flattenWeeklyWriteStats,
  mergeFlattenedWriteStats,
  resolveWeeklyTerminalStatus,
  resolveLedgerRunStatus
};
