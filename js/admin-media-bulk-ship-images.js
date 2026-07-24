/**
 * Marketing → Media Library → Bulk Ship Images (Sprint 16D).
 * Presentation + client orchestration only; ZIP processing is server-side.
 */
(function (global) {
  "use strict";

  let lines = [];
  let selectedLineId = "";
  let zipFile = null;
  let zipMeta = null;
  let dryReport = null;
  let importResult = null;
  let busy = false;
  let message = "";
  let messageTone = "";
  let mode = "single_line";

  function esc(value) {
    return typeof global.esc === "function"
      ? global.esc(value)
      : String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");
  }

  async function authHeaders() {
    if (typeof global.adminAuthHeaders === "function") return global.adminAuthHeaders();
    return { "Content-Type": "application/json" };
  }

  async function api(action, payload = {}) {
    const headers = await authHeaders();
    const response = await fetch("/.netlify/functions/bulk-ship-images", {
      method: "POST",
      headers,
      body: JSON.stringify({ action, ...payload })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      throw new Error(data.error || `Request failed (${response.status})`);
    }
    return data;
  }

  async function ensureLines() {
    if (lines.length) return;
    const data = await api("list_lines");
    lines = data.cruise_lines || [];
    if (!selectedLineId && lines[0]) selectedLineId = lines[0].id;
  }

  async function uploadZipToStaging(file) {
    const prepared = await api("create_zip_upload", {
      filename: file.name,
      size_bytes: file.size
    });
    const client =
      typeof global.getAdminSupabaseClient === "function"
        ? global.getAdminSupabaseClient()
        : global.supabaseClient;
    if (!client?.storage) throw new Error("Supabase client is not available.");
    const { error: uploadError } = await client.storage
      .from(prepared.bucket)
      .uploadToSignedUrl(prepared.storage_path, prepared.token, file, {
        contentType: "application/zip"
      });
    if (uploadError) throw new Error(uploadError.message || "ZIP staging upload failed");
    return prepared.storage_path;
  }

  function formatBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
    return `${(v / (1024 * 1024)).toFixed(2)} MB`;
  }

  function downloadReport(kind) {
    const payload = kind === "import" ? importResult : dryReport;
    if (!payload) return;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = kind === "import" ? "bulk-ship-import-result.json" : "bulk-ship-dry-run.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function renderReport(report, title) {
    if (!report) return "";
    const unmatched = (report.unmatched_ship_folders || [])
      .map((u) => `<li>${esc(u.folder)} (${esc(String(u.image_count || 0))} images)</li>`)
      .join("");
    const matched = (report.matched_ships || [])
      .map(
        (m) =>
          `<li>${esc(m.folder)} → ${esc(m.ship_name)} <span class="admin-muted">(${esc(m.via)})</span></li>`
      )
      .join("");
    const heroes = (report.proposed_heroes || report.hero_suggestions || [])
      .map(
        (h) =>
          `<li>${esc(h.ship_name || "")}: ${esc(h.filename || h.public_url || "")} — suggestion only</li>`
      )
      .join("");
    return `
      <div class="admin-card">
        <div class="admin-list-top">
          <div>
            <h4>${esc(title)}</h4>
            <p class="admin-muted">${esc(report.cruise_line?.name || "—")}</p>
          </div>
          <button type="button" class="admin-button secondary small" onclick="MediaBulkShipImages.downloadJson('${
            title.includes("Import") ? "import" : "dry"
          }')">Download JSON</button>
        </div>
        <div class="usage-summary-grid">
          <article class="admin-card usage-summary-card"><p class="usage-summary-label">Ship folders</p><p class="usage-summary-value">${esc(
            String((report.ship_folders || []).length || report.ship_folders_processed || 0)
          )}</p></article>
          <article class="admin-card usage-summary-card"><p class="usage-summary-label">Matched ships</p><p class="usage-summary-value">${esc(
            String((report.matched_ships || []).length || report.ships_matched || 0)
          )}</p></article>
          <article class="admin-card usage-summary-card"><p class="usage-summary-label">Proposed uploads</p><p class="usage-summary-value">${esc(
            String((report.proposed_uploads || []).length || report.images_uploaded || 0)
          )}</p></article>
          <article class="admin-card usage-summary-card"><p class="usage-summary-label">Duplicates</p><p class="usage-summary-value">${esc(
            String((report.duplicate_candidates || []).length || report.duplicates_skipped || 0)
          )}</p></article>
          <article class="admin-card usage-summary-card"><p class="usage-summary-label">Unmatched folders</p><p class="usage-summary-value">${esc(
            String((report.unmatched_ship_folders || report.unmatched_folders || []).length)
          )}</p></article>
          <article class="admin-card usage-summary-card"><p class="usage-summary-label">Est. / uploaded</p><p class="usage-summary-value">${esc(
            formatBytes(report.estimated_upload_bytes || report.total_uploaded_bytes || 0)
          )}</p></article>
        </div>
        ${matched ? `<h4>Matched</h4><ul>${matched}</ul>` : ""}
        ${unmatched ? `<h4>Unmatched (review)</h4><ul>${unmatched}</ul>` : ""}
        ${heroes ? `<h4>Hero suggestions</h4><ul>${heroes}</ul>` : ""}
        ${(report.unsupported_files || []).length ? `<h4>Unsupported</h4><p class="admin-muted">${esc(String(report.unsupported_files.length))} file(s)</p>` : ""}
        ${(report.failed_uploads || []).length ? `<h4>Failures</h4><ul>${report.failed_uploads.map((f) => `<li>${esc(f.path)}: ${esc(f.error)}</li>`).join("")}</ul>` : ""}
      </div>
    `;
  }

  function renderPanel() {
    const lineOptions = lines
      .map(
        (l) =>
          `<option value="${esc(l.id)}" ${selectedLineId === l.id ? "selected" : ""}>${esc(l.name)}${
            l.active === false ? " (inactive)" : ""
          }</option>`
      )
      .join("");

    return `
      <div class="admin-card">
        <div class="admin-list-top">
          <div>
            <p class="admin-nav-eyebrow">Marketing</p>
            <h3>Bulk Ship Images</h3>
            <p class="admin-muted">Upload one ZIP per cruise line. Matches folders to ci_cruise_ships. Never creates ships or overwrites heroes automatically.</p>
          </div>
        </div>
        ${message ? `<div class="admin-message ${messageTone === "error" ? "admin-error" : messageTone === "success" ? "admin-success" : "admin-running"}">${esc(message)}</div>` : ""}
        <div class="featured-form-grid">
          <div class="admin-field">
            <label>Mode</label>
            <select id="bulkShipMode" onchange="MediaBulkShipImages.setMode(this.value)" ${busy ? "disabled" : ""}>
              <option value="single_line" ${mode === "single_line" ? "selected" : ""}>Single cruise line ZIP</option>
              <option value="full_library" ${mode === "full_library" ? "selected" : ""}>Full library ZIP (dry-run only)</option>
            </select>
          </div>
          <div class="admin-field">
            <label>Cruise line</label>
            <select id="bulkShipLine" onchange="MediaBulkShipImages.setLine(this.value)" ${busy || mode === "full_library" ? "disabled" : ""}>
              <option value="">Select cruise line…</option>
              ${lineOptions}
            </select>
          </div>
          <div class="admin-field">
            <label>ZIP file</label>
            <input type="file" accept=".zip,application/zip" onchange="MediaBulkShipImages.onZipChosen(event)" ${busy ? "disabled" : ""}>
            <div class="admin-helper">Structure: Ship Name / image.jpg · Max 50 MB · JPG/PNG/WebP only</div>
            ${zipFile ? `<p class="admin-small">${esc(zipFile.name)} · ${esc(formatBytes(zipFile.size))}</p>` : ""}
          </div>
        </div>
        <div class="admin-actions-row" style="margin-top:12px">
          <button type="button" class="admin-button secondary" onclick="MediaBulkShipImages.runDryRun()" ${busy || !zipFile ? "disabled" : ""}>${busy ? "Working…" : "Dry run"}</button>
          <button type="button" class="admin-button black" onclick="MediaBulkShipImages.runImport()" ${
            busy || !dryReport?.confirm_token || mode === "full_library" ? "disabled" : ""
          }>Confirm import</button>
        </div>
        <p class="admin-small" style="margin-top:10px">Dry run writes nothing. Import uses content hashes for idempotent dedupe. Hero files named hero.jpg / primary.jpg are suggestions only.</p>
      </div>
      ${dryReport ? renderReport(dryReport, "Dry-run report") : ""}
      ${importResult ? renderReport(importResult, "Import result") : ""}
    `;
  }

  async function boot() {
    try {
      await ensureLines();
    } catch (error) {
      message = error.message || "Could not load cruise lines";
      messageTone = "error";
    }
  }

  global.MediaBulkShipImages = {
    async ensureLoaded() {
      await boot();
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    renderPanel,
    setMode(value) {
      mode = value === "full_library" ? "full_library" : "single_line";
      dryReport = null;
      importResult = null;
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    setLine(value) {
      selectedLineId = value;
      dryReport = null;
      importResult = null;
    },
    onZipChosen(event) {
      const file = event.target?.files?.[0] || null;
      zipFile = file;
      zipMeta = null;
      dryReport = null;
      importResult = null;
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    downloadJson(kind) {
      downloadReport(kind === "import" ? "import" : "dry");
    },
    async runDryRun() {
      if (!zipFile) return;
      if (mode === "single_line" && !selectedLineId) {
        message = "Select a cruise line first.";
        messageTone = "error";
        if (typeof global.renderAdmin === "function") global.renderAdmin();
        return;
      }
      busy = true;
      message = "Staging ZIP and analysing…";
      messageTone = "running";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
      try {
        const zipPath = await uploadZipToStaging(zipFile);
        zipMeta = { storage_path: zipPath };
        const data = await api("dry_run", {
          zip_storage_path: zipPath,
          cruise_line_id: selectedLineId,
          mode
        });
        dryReport = data.report;
        importResult = null;
        message = "Dry run complete — review the report before importing.";
        messageTone = "success";
      } catch (error) {
        message = error.message || "Dry run failed";
        messageTone = "error";
      } finally {
        busy = false;
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async runImport() {
      if (!dryReport?.confirm_token || !zipMeta?.storage_path) return;
      if (!window.confirm("Import images from this ZIP? Duplicates will be skipped. Heroes will not be overwritten.")) {
        return;
      }
      busy = true;
      message = "Importing images…";
      messageTone = "running";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
      try {
        const data = await api("import", {
          zip_storage_path: zipMeta.storage_path,
          cruise_line_id: selectedLineId,
          confirm_token: dryReport.confirm_token
        });
        importResult = data.result;
        message = `Import finished — ${data.result?.images_uploaded || 0} uploaded, ${data.result?.duplicates_skipped || 0} duplicates skipped.`;
        messageTone = "success";
      } catch (error) {
        message = error.message || "Import failed";
        messageTone = "error";
      } finally {
        busy = false;
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    }
  };
})(window);
