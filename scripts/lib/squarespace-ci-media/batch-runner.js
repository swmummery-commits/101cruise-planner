/**
 * Controlled Original-project batch orchestration (injectable for offline tests).
 * Processes an explicit approved list one line at a time. Not a DB transaction.
 */

/**
 * @param {{
 *   mode: "dry-run"|"copy"|"promote",
 *   batch: object,
 *   projectRef: string,
 *   loadCatalogue: () => Promise<{lines:any[], ships:any[], media:any[]}>,
 *   processLine: (ctx) => Promise<object>,
 *   now?: () => string
 * }} opts
 */
export async function runApprovedBatch({
  mode,
  batch,
  projectRef,
  loadCatalogue,
  processLine,
  now = () => new Date().toISOString()
}) {
  const startedAt = now();
  const perLine = [];
  let failed = null;
  let catalogue = null;

  // Catalogue load is the first network touch — caller must gate CLI first.
  catalogue = await loadCatalogue();

  const linesById = new Map((catalogue.lines || []).map((l) => [String(l.id), l]));

  for (const approved of batch.lines) {
    const resolved = linesById.get(String(approved.id)) || null;
    try {
      const result = await processLine({
        mode,
        batch,
        approved,
        resolvedLine: resolved,
        catalogue,
        projectRef
      });
      perLine.push(result);
      if (result.status === "failed") {
        failed = {
          line_id: approved.id,
          line_name: approved.name,
          order: approved.order,
          reason: result.error || "unknown failure",
          code: result.code || null
        };
        break;
      }
    } catch (error) {
      const result = {
        order: approved.order,
        line_id: approved.id,
        line_name: approved.name,
        status: "failed",
        error: error.message,
        code: error.code || null,
        uploads: 0,
        media_library_inserts: 0,
        ci_urls_changed: 0,
        promoted_fields: [],
        rollback_manifest_path: null,
        report_path: null
      };
      perLine.push(result);
      failed = {
        line_id: approved.id,
        line_name: approved.name,
        order: approved.order,
        reason: error.message,
        code: error.code || null
      };
      break;
    }
  }

  const completed = perLine.filter((r) => r.status !== "failed");
  const unfinished = batch.lines.slice(perLine.length);

  const summary = {
    mode,
    target: "production",
    batch_name: batch.id,
    project_ref: projectRef,
    strategy: "verified sequential per-line processing (not a database transaction)",
    started_at: startedAt,
    finished_at: now(),
    total_lines: batch.lines.length,
    completed_lines: completed.length,
    failed_line: failed,
    stopped_early: Boolean(failed),
    unprocessed_lines: unfinished.map((l) => ({
      order: l.order,
      id: l.id,
      name: l.name
    })),
    uploaded_assets: completed.reduce((n, r) => n + (r.uploaded_count || 0), 0),
    skipped_existing_assets: completed.reduce((n, r) => n + (r.skipped_already_migrated || 0), 0),
    promoted_fields: completed.reduce((n, r) => n + (r.promoted_fields?.length || 0), 0),
    total_bytes: completed.reduce((n, r) => n + (r.bytes_uploaded || 0), 0),
    per_line_report_paths: perLine.map((r) => r.report_path).filter(Boolean),
    rollback_manifest_paths: perLine.map((r) => r.rollback_manifest_path).filter(Boolean),
    original_project_writes: mode === "dry-run" ? 0 : completed.filter((r) => r.wrote).length,
    dev_writes: 0,
    lines: perLine
  };

  return summary;
}

export function summariseCopyResults(copyResults) {
  const rows = copyResults || [];
  let uploaded = 0;
  let inserted = 0;
  let skipped = 0;
  let duplicates = 0;
  let bytes = 0;
  const publicUrls = [];
  for (const r of rows) {
    if (r.ci_url_changed) {
      throw Object.assign(new Error("REFUSED: batch copy changed a CI URL"), {
        code: "batch_copy_ci_url_changed"
      });
    }
    if (
      r.copy_result === "skipped_already_present" ||
      r.copy_result === "skipped_duplicate_hash" ||
      r.status === "already_copied" ||
      r.status === "already_promoted"
    ) {
      skipped += 1;
      if (r.copy_result === "skipped_duplicate_hash") duplicates += 1;
      if (r.proposed_public_url || r.public_url) {
        publicUrls.push(r.proposed_public_url || r.public_url);
      }
      continue;
    }
    if (r.copy_result === "uploaded" || r.copy_result === "uploaded_new") {
      uploaded += 1;
      inserted += 1;
      bytes += r.bytes || 0;
      if (r.proposed_public_url) publicUrls.push(r.proposed_public_url);
    }
  }
  return {
    uploaded_count: uploaded,
    media_library_inserted_count: inserted,
    skipped_already_migrated: skipped,
    duplicate_count: duplicates,
    bytes_uploaded: bytes,
    public_urls: publicUrls
  };
}
