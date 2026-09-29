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
  const idempotentSkips = num(summary.idempotent_skips, writes.idempotent_skips);
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
    idempotent_skips: idempotentSkips,
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
    idempotent_skips: flat.idempotent_skips,
    write_attempts: flat.write_attempts,
    committed_material_writes: flat.committed_material_writes,
    inventory_changed: flat.inventory_changed,
    rollback_manifest_id: summary.rollback_manifest_id || flat.rollback_manifest_id
  };
}

const DELIBERATE_NON_WRITING_TERMINALS = Object.freeze([
  "review_required",
  "review_required_blocked",
  "source_repair_required",
  "source_unstable",
  "read_only",
  "controlled_catchup_required",
  "not_yet_commissioned",
  "disabled",
  "source_worker_not_started",
  "SOURCE_WORKER_NOT_STARTED",
  "stale_source_worker",
  "STALE_SOURCE_WORKER"
]);

const FAILED_TERMINALS = Object.freeze(["failed_before_writes", "partial_write_failure"]);

const CLASSIFIED_REASON_TERMINALS = Object.freeze({
  REVIEW_REQUIRED: "review_required",
  "REVIEW REQUIRED — NO WRITES": "review_required",
  SOURCE_REPAIR_REQUIRED: "source_repair_required",
  SOURCE_UNSTABLE: "source_unstable",
  SOURCE_TIMEOUT: "source_unstable",
  READ_ONLY: "read_only",
  CONTROLLED_CATCHUP_REQUIRED: "controlled_catchup_required",
  NOT_YET_COMMISSIONED: "not_yet_commissioned",
  DISABLED: "disabled",
  SOURCE_WORKER_NOT_STARTED: "source_worker_not_started",
  source_worker_not_started: "source_worker_not_started",
  STALE_SOURCE_WORKER: "stale_source_worker",
  stale_source_worker: "stale_source_worker",
  carnival_discovery_write_forbidden: "not_yet_commissioned",
  azamara_source_collapse: "source_repair_required",
  azamara_zero_source: "source_repair_required",
  disney_source_timeout: "source_unstable",
  royal_caribbean_source_repair_required: "source_repair_required",
  silversea_review_required: "review_required",
  silversea_read_only: "read_only"
});

function normaliseTerminalToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function isDeliberateNonWritingTerminal(terminalStatus) {
  return DELIBERATE_NON_WRITING_TERMINALS.includes(normaliseTerminalToken(terminalStatus));
}

function resolveDeclaredTerminalStatus(result = {}) {
  const declared =
    result.terminal_status ||
    result.summary?.terminal_status ||
    null;
  const normalised = normaliseTerminalToken(declared);
  if (DELIBERATE_NON_WRITING_TERMINALS.includes(normalised)) return normalised;
  if (result.source_repair_required === true) return "source_repair_required";
  if (result.source_unstable === true) return "source_unstable";
  if (result.review_required === true) return "review_required";
  if (result.not_yet_commissioned === true) return "not_yet_commissioned";
  if (result.read_only === true) return "read_only";
  if (result.disabled === true) return "disabled";
  const reasonKey = String(result.reason || "").trim();
  if (CLASSIFIED_REASON_TERMINALS[reasonKey]) return CLASSIFIED_REASON_TERMINALS[reasonKey];
  const reasonNorm = normaliseTerminalToken(reasonKey);
  if (DELIBERATE_NON_WRITING_TERMINALS.includes(reasonNorm)) return reasonNorm;
  if (CLASSIFIED_REASON_TERMINALS[reasonNorm]) return CLASSIFIED_REASON_TERMINALS[reasonNorm];
  return null;
}

function resolveWeeklyTerminalStatus({
  ok,
  blocked = false,
  review_required = false,
  already_running = false,
  reason = null,
  summary = {},
  terminal_status = null,
  source_repair_required = false,
  source_unstable = false,
  not_yet_commissioned = false,
  read_only = false,
  disabled = false
} = {}) {
  const flat = flattenWeeklyWriteStats(summary);
  const declared = resolveDeclaredTerminalStatus({
    terminal_status: terminal_status || summary.terminal_status,
    summary,
    reason,
    review_required,
    source_repair_required,
    source_unstable,
    not_yet_commissioned,
    read_only,
    disabled
  });
  if (already_running || reason === "maintenance_lock_held") return "completed";
  if (declared === "completed_with_review") return "completed_with_review";
  if (declared && isDeliberateNonWritingTerminal(declared) && flat.committed_material_writes === 0) {
    return declared;
  }
  if (review_required && flat.committed_material_writes > 0) return "completed_with_review";
  if (review_required && flat.committed_material_writes === 0) return declared === "review_required_blocked" ? "review_required_blocked" : "review_required";
  if (!ok && flat.committed_material_writes > 0) return "partial_write_failure";
  if (!ok && flat.committed_material_writes === 0 && !declared) return "failed_before_writes";
  if (
    ok &&
    (summary.staged_match_required_inserts > 0 || summary.line_slug === "norwegian-cruise-line") &&
    flat.inserts > 0 &&
    flat.promoted_active === 0
  ) {
    return "completed_with_staged_rows";
  }
  if (ok) return declared && isDeliberateNonWritingTerminal(declared) ? declared : "completed";
  if (blocked && flat.committed_material_writes === 0 && !declared) return "failed_before_writes";
  return declared && isDeliberateNonWritingTerminal(declared) ? declared : "failed_before_writes";
}

function resolveLedgerRunStatus(terminalStatus) {
  if (
    terminalStatus === "completed" ||
    terminalStatus === "completed_with_staged_rows" ||
    terminalStatus === "completed_with_review"
  ) {
    return "completed";
  }
  if (isDeliberateNonWritingTerminal(terminalStatus)) return "completed";
  return "failed";
}

function weeklyDispatchStatus(result = {}) {
  if (result.duplicate_background_invocation) return "duplicate_background_invocation";
  if (result.blocked && result.already_running) return "already_running";
  const terminal = result.summary?.terminal_status || result.terminal_status || resolveDeclaredTerminalStatus(result);
  if (terminal && isDeliberateNonWritingTerminal(terminal)) return terminal;
  if (result.review_required) return "review_required";
  if (result.success) return "completed";
  return "failed";
}

module.exports = {
  flattenWeeklyWriteStats,
  mergeFlattenedWriteStats,
  resolveWeeklyTerminalStatus,
  resolveLedgerRunStatus,
  resolveDeclaredTerminalStatus,
  isDeliberateNonWritingTerminal,
  weeklyDispatchStatus,
  DELIBERATE_NON_WRITING_TERMINALS,
  FAILED_TERMINALS
};
