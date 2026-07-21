/**
 * Admin Research Content tab — list, research workflow, review editor.
 * Sprint 10D
 */
(function (global) {
  "use strict";

  const ENTITY_LABELS = {
    ship: "Ship",
    destination: "Destination",
    port: "Port",
    cruise_line: "Cruise Line"
  };

  const STATUS_LABELS = {
    draft: "Draft",
    reviewed: "Reviewed",
    published: "Published",
    archived: "Archived",
    failed: "Failed"
  };

  const FRESHNESS_LABELS = {
    current: "Current",
    review_soon: "Review Soon",
    overdue: "Overdue",
    unknown: "Unknown"
  };

  const SHIP_FIELDS = [
    ["overview", "Overview", "textarea"],
    ["personality", "Personality", "textarea"],
    ["best_for", "Best for", "list"],
    ["not_ideal_for", "Not ideal for", "list"],
    ["dining_summary", "Dining", "textarea"],
    ["entertainment_summary", "Entertainment", "textarea"],
    ["wellness_summary", "Wellness", "textarea"],
    ["accommodation_summary", "Accommodation", "textarea"],
    ["accessibility_summary", "Accessibility", "textarea"],
    ["connectivity_summary", "Connectivity", "textarea"],
    ["dress_code_summary", "Dress code", "textarea"],
    ["included_summary", "Typically included", "list"],
    ["extra_cost_summary", "Often extra cost", "list"],
    ["family_summary", "Families", "textarea"],
    ["solo_traveller_summary", "Solo travellers", "textarea"],
    ["key_highlights", "Key highlights", "list"],
    ["frequently_asked_questions", "FAQs", "faq"],
    ["research_notes", "Research notes (internal)", "textarea"]
  ];

  const DESTINATION_FIELDS = [
    ["overview", "Overview", "textarea"],
    ["why_visit", "Why visit", "textarea"],
    ["best_time_to_visit", "Best time to visit", "textarea"],
    ["climate_summary", "Climate", "textarea"],
    ["ideal_for", "Ideal for", "list"],
    ["key_highlights", "Key highlights", "list"],
    ["signature_experiences", "Signature experiences", "list"],
    ["food_and_drink", "Food and drink", "textarea"],
    ["culture_and_etiquette", "Culture and etiquette", "textarea"],
    ["currency", "Currency", "text"],
    ["languages", "Languages", "text"],
    ["transport_summary", "Transport", "textarea"],
    ["accessibility_summary", "Accessibility", "textarea"],
    ["family_summary", "Families", "textarea"],
    ["packing_summary", "Packing", "textarea"],
    ["frequently_asked_questions", "FAQs", "faq"],
    ["research_notes", "Research notes (internal)", "textarea"]
  ];

  const PORT_FIELDS = [
    ["overview", "Overview", "textarea"],
    ["why_visit", "Why visit", "textarea"],
    ["must_see", "Must see", "list"],
    ["typical_cruise_day", "Typical cruise day", "textarea"],
    ["getting_from_port", "Getting from port", "textarea"],
    ["walking_difficulty", "Walking difficulty", "text"],
    ["accessibility_summary", "Accessibility", "textarea"],
    ["currency", "Currency", "text"],
    ["languages", "Languages", "text"],
    ["transport", "Transport", "textarea"],
    ["food_to_try", "Food to try", "textarea"],
    ["shopping", "Shopping", "textarea"],
    ["shore_excursion_ideas", "Shore excursion ideas", "list"],
    ["independent_exploration", "Independent exploration", "textarea"],
    ["practical_tips", "Practical tips", "list"],
    ["tender_port", "Tender port", "tender"],
    ["frequently_asked_questions", "FAQs", "faq"],
    ["research_notes", "Research notes (internal)", "textarea"]
  ];

  const CRUISE_LINE_FIELDS = [
    ["overview", "Overview", "textarea"],
    ["market_position", "Market position", "textarea"],
    ["brand_personality", "Brand personality", "textarea"],
    ["best_for", "Best for", "list"],
    ["not_ideal_for", "Not ideal for", "list"],
    ["dining_style", "Dining style", "textarea"],
    ["dress_code", "Dress code", "textarea"],
    ["entertainment_style", "Entertainment", "textarea"],
    ["family_friendly", "Family friendly", "textarea"],
    ["solo_friendly", "Solo friendly", "textarea"],
    ["accessibility_summary", "Accessibility", "textarea"],
    ["drinks_summary", "Drinks (may vary)", "textarea"],
    ["wifi_summary", "Wi-Fi (may vary)", "textarea"],
    ["gratuities_summary", "Gratuities (may vary)", "textarea"],
    ["included_summary", "Typically included", "list"],
    ["extra_cost_summary", "Often extra cost", "list"],
    ["loyalty_program_summary", "Loyalty program", "textarea"],
    ["frequently_asked_questions", "FAQs", "faq"],
    ["research_notes", "Research notes (internal)", "textarea"]
  ];

  let items = [];
  let loading = false;
  let message = "";
  let messageTone = "";
  let filterEntity = "all";
  let filterStatus = "all";
  let filterFreshness = "all";
  let searchQuery = "";
  let view = "list"; // list | research | editor
  let editingId = null;
  let editorItem = null;
  let editorSources = [];
  let publishedSibling = null;
  let editorDraft = null;
  let saving = false;
  let researching = false;
  let showRawJson = false;
  let providerInfo = null;
  let batchRunning = false;
  let batchCancelRequested = false;
  let batchProgress = null; // { total, done, currentName, results, startedAt, lineName }
  let singleResearchStartedAt = null;
  // idle | publishing | done | empty | error
  let linePublishState = null; // { status, total, done, ok, fail, lineName }

  const BATCH_STORAGE_KEY = "101cruise_research_batch_progress";

  function saveBatchProgress() {
    try {
      if (!batchRunning || !batchProgress) {
        sessionStorage.removeItem(BATCH_STORAGE_KEY);
        return;
      }
      sessionStorage.setItem(
        BATCH_STORAGE_KEY,
        JSON.stringify({
          ...batchProgress,
          batch_line_id: researchForm.batch_line_id,
          running: true
        })
      );
    } catch {
      // ignore
    }
  }

  function clearBatchProgressStorage() {
    try {
      sessionStorage.removeItem(BATCH_STORAGE_KEY);
    } catch {
      // ignore
    }
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "—";
    const totalSec = Math.round(ms / 1000);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    if (mins <= 0) return `${secs}s`;
    return `${mins}m ${secs}s`;
  }

  function batchEtaText() {
    if (!batchProgress || !batchProgress.startedAt) return "";
    const done = Number(batchProgress.done) || 0;
    const total = Number(batchProgress.total) || 0;
    const remaining = Math.max(0, total - done);
    if (done < 1) {
      return `About ${formatDuration(remaining * 45 * 1000)} remaining (rough estimate)`;
    }
    const elapsed = Date.now() - batchProgress.startedAt;
    const avg = elapsed / done;
    return `About ${formatDuration(remaining * avg)} remaining`;
  }

  function renderWorkingBanner() {
    if (batchRunning && batchProgress) {
      const done = Number(batchProgress.done) || 0;
      const total = Math.max(1, Number(batchProgress.total) || 1);
      const pct = Math.min(100, Math.round((done / total) * 100));
      const eta = batchEtaText();
      return `
        <div class="research-working-banner" role="status" aria-live="polite">
          <div class="research-working-top">
            <span class="research-spinner" aria-hidden="true"></span>
            <div>
              <p class="research-working-title">Research in progress${batchProgress.lineName ? ` — ${esc(batchProgress.lineName)}` : ""}</p>
              <p class="research-working-sub">
                ${esc(String(done))} of ${esc(String(total))} ships complete
                ${batchProgress.currentName ? ` · Currently: <strong>${esc(batchProgress.currentName)}</strong>` : ""}
              </p>
              <p class="research-working-eta">${esc(eta)} · Keep this tab open</p>
            </div>
            <button type="button" class="admin-button danger" onclick="ResearchContentAdmin.cancelBatch()">Stop after current</button>
          </div>
          <div class="research-progress-track" aria-hidden="true">
            <div class="research-progress-fill" style="width:${pct}%"></div>
          </div>
        </div>
      `;
    }
    if (researching) {
      return `
        <div class="research-working-banner" role="status" aria-live="polite">
          <div class="research-working-top">
            <span class="research-spinner" aria-hidden="true"></span>
            <div>
              <p class="research-working-title">Researching…</p>
              <p class="research-working-sub">Searching sources and writing the draft. This usually takes under a minute.</p>
            </div>
          </div>
        </div>
      `;
    }
    return "";
  }

  let researchForm = {
    entity_type: "ship",
    entity_id: "",
    entity_name: "",
    entity_key: "",
    confirm_duplicate: false,
    refresh_of: "",
    estimate: null,
    duplicates: [],
    batch_line_id: "",
    batch_skip_existing: true,
    batch_auto_publish: true
  };

  let entityOptions = [];

  function esc(value) {
    return typeof global.esc === "function"
      ? global.esc(value)
      : String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");
  }

  function fieldsFor(type) {
    if (type === "ship") return SHIP_FIELDS;
    if (type === "destination") return DESTINATION_FIELDS;
    if (type === "port") return PORT_FIELDS;
    return CRUISE_LINE_FIELDS;
  }

  async function api(action, payload = {}, endpoint = "research-content") {
    const headers =
      typeof global.adminAuthHeaders === "function"
        ? await global.adminAuthHeaders()
        : { "Content-Type": "application/json" };
    const response = await fetch(`/.netlify/functions/${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action, ...payload })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      let msg = data.error || `Request failed (${response.status})`;
      if (response.status === 504 || response.status === 502) {
        msg =
          "Research timed out before finishing. Check the Research Content list for a Failed draft — open it and use Retry Generation (sources are often already saved). Or try again.";
      }
      const err = new Error(msg);
      err.code = data.code || (response.status === 504 ? "timeout" : undefined);
      err.payload = data;
      err.status = response.status;
      throw err;
    }
    return data;
  }

  async function ensureLoaded({ quiet = false } = {}) {
    loading = true;
    if (!quiet) {
      message = "";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    }
    try {
      // One-time cleanup of archived leftovers from older publish behaviour
      await api("purge_archived").catch(() => null);
      const [listResult, status] = await Promise.all([
        api("list", {
          entity_type: filterEntity === "all" ? undefined : filterEntity,
          content_status: filterStatus === "all" ? undefined : filterStatus,
          freshness: filterFreshness === "all" ? undefined : filterFreshness,
          q: searchQuery || undefined,
          limit: 300
        }),
        api("provider_status").catch(() => null)
      ]);
      items = listResult.items || [];
      providerInfo = status;
    } catch (error) {
      message = error.message || "Could not load research content";
      messageTone = "error";
      items = [];
    } finally {
      loading = false;
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    }
  }

  function formatDate(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleDateString("en-AU", {
        day: "numeric",
        month: "short",
        year: "numeric"
      });
    } catch {
      return "—";
    }
  }

  function researchOptionLabel(entity) {
    const name = entity.name || entity.entity_name || "Untitled";
    if (!entity.research_updated_at) return name;
    return `${name} · ${formatDate(entity.research_updated_at)}`;
  }

  function selectedEntityResearchNote() {
    const isCanonical = researchForm.entity_type === "ship" || researchForm.entity_type === "cruise_line";
    const found = isCanonical
      ? entityOptions.find((e) => e.id === researchForm.entity_id)
      : entityOptions.find((e) => e.entity_key === researchForm.entity_key);

    if (!found?.research_updated_at) return "";
    const openBtn = found.research_id
      ? ` <button type="button" class="admin-button secondary small" onclick="ResearchContentAdmin.openEditor('${esc(found.research_id)}')">Open existing</button>`
      : "";
    return `<p class="research-last-updated">Last updated: <strong>${esc(formatDate(found.research_updated_at))}</strong>${openBtn}</p>`;
  }

  function openList() {
    view = "list";
    editingId = null;
    editorItem = null;
    editorSources = [];
    publishedSibling = null;
    editorDraft = null;
    showRawJson = false;
    if (typeof global.renderAdmin === "function") global.renderAdmin();
  }

  async function openEditor(id) {
    loading = true;
    message = "";
    if (typeof global.renderAdmin === "function") global.renderAdmin();
    try {
      const data = await api("get", { id });
      editingId = id;
      editorItem = data.item;
      editorSources = data.sources || [];
      publishedSibling = data.published_sibling || null;
      editorDraft = {
        content_json: JSON.parse(JSON.stringify(data.item.content_json || {})),
        summary_text: data.item.summary_text || "",
        seo_title: data.item.seo_title || "",
        meta_description: data.item.meta_description || "",
        canonical_slug: data.item.canonical_slug || "",
        pauls_tip: data.item.pauls_tip || "",
        media_id: data.item.media_id || ""
      };
      view = "editor";
    } catch (error) {
      message = error.message || "Could not open research content";
      messageTone = "error";
    } finally {
      loading = false;
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    }
  }

  async function openResearch() {
    view = "research";
    if (!batchRunning) {
      batchProgress = null;
      batchCancelRequested = false;
      try {
        const raw = sessionStorage.getItem(BATCH_STORAGE_KEY);
        if (raw) {
          const saved = JSON.parse(raw);
          if (saved?.running) {
            message = `A previous batch may have been interrupted at ${saved.done || 0}/${saved.total || "?"} (${saved.lineName || "cruise line"}). Check the list for what was saved, then re-run with “Skip ships that already have research”.`;
            messageTone = "warning";
            clearBatchProgressStorage();
          }
        }
      } catch {
        // ignore
      }
      researchForm = {
        entity_type: "ship",
        entity_id: "",
        entity_name: "",
        entity_key: "",
        confirm_duplicate: false,
        refresh_of: "",
        estimate: null,
        duplicates: [],
        batch_line_id: "",
        batch_skip_existing: true,
        batch_auto_publish: true
      };
    }
    await loadEntityOptions("ship");
    try {
      const est = await api("estimate", {}, "research-content-generate");
      researchForm.estimate = est.estimate;
    } catch {
      researchForm.estimate = null;
    }
    if (typeof global.renderAdmin === "function") global.renderAdmin();
  }

  function cruiseLinesFromShips() {
    const map = new Map();
    for (const ship of entityOptions) {
      if (!ship.cruise_line_id) continue;
      const name = ship.ci_cruise_lines?.name || "Cruise line";
      if (!map.has(ship.cruise_line_id)) map.set(ship.cruise_line_id, name);
    }
    return [...map.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "en"));
  }

  function shipsForBatchLine(lineId) {
    return entityOptions.filter((ship) => ship.cruise_line_id === lineId);
  }

  function batchQueueForLine(lineId) {
    const ships = shipsForBatchLine(lineId);
    if (researchForm.batch_skip_existing) {
      return ships.filter((ship) => !ship.research_updated_at);
    }
    return ships;
  }

  async function loadEntityOptions(entityType) {
    try {
      const data = await api("list_entities", { entity_type: entityType });
      entityOptions = data.entities || [];
    } catch {
      entityOptions = [];
    }
  }

  function renderList() {
    const rows = items
      .map((item) => {
        const fresh = item.freshness || "unknown";
        const canPublish =
          item.content_status === "draft" || item.content_status === "reviewed";
        const warnClass =
          item.content_status === "failed"
            ? " research-row--failed"
            : fresh === "overdue"
              ? " research-row--overdue"
              : fresh === "review_soon"
                ? " research-row--soon"
                : "";
        return `
          <tr class="research-row admin-object-card${warnClass}" role="button" tabindex="0"
            aria-label="Open research for ${esc(item.entity_name)}"
            onclick="ResearchContentAdmin.openEditor('${esc(item.id)}')"
            onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();ResearchContentAdmin.openEditor('${esc(item.id)}')}">
            <td class="research-row-name">
              <strong>${esc(item.entity_name)}</strong>
              ${item.failure_detail ? `<span class="research-row-warning">${esc(item.failure_detail)}</span>` : ""}
            </td>
            <td><span class="research-pill">${esc(ENTITY_LABELS[item.entity_type] || item.entity_type)}</span></td>
            <td><span class="research-status research-status--${esc(item.content_status)}">${esc(STATUS_LABELS[item.content_status] || item.content_status)}</span></td>
            <td><span class="research-freshness research-freshness--${esc(fresh)}">${esc(FRESHNESS_LABELS[fresh] || fresh)}</span></td>
            <td>${esc(formatDate(item.generated_at))}</td>
            <td>${esc(formatDate(item.last_reviewed_at))}</td>
            <td>${esc(formatDate(item.refresh_after))}</td>
            <td>${esc(String(item.source_count ?? 0))}</td>
            <td class="research-row-actions" onclick="event.stopPropagation()">
              ${
                canPublish
                  ? `<button type="button" class="admin-button black small" onclick="event.stopPropagation();ResearchContentAdmin.publishFromList('${esc(item.id)}')">Publish</button>`
                  : item.content_status === "published"
                    ? `<span class="admin-muted">Published</span>`
                    : item.content_status === "failed"
                      ? `<button type="button" class="admin-button secondary small" onclick="event.stopPropagation();ResearchContentAdmin.openEditor('${esc(item.id)}')">Fix</button>`
                      : ""
              }
            </td>
          </tr>
        `;
      })
      .join("");

    const providerNote = providerInfo
      ? `<p class="admin-muted research-provider-note">Brave: ${providerInfo.brave_configured ? "configured" : "missing"} · AI: ${providerInfo.ai_configured ? `${esc(providerInfo.ai_provider)} / ${esc(providerInfo.ai_model)}` : "OPENAI_API_KEY required"}</p>`
      : "";

    return `
      <section class="admin-panel research-panel">
        <div class="admin-panel-header">
          <div>
            <h2>Research Content</h2>
            <p class="admin-muted">Research once, review, publish, and reuse across cruise pages.</p>
            ${providerNote}
          </div>
          <button type="button" class="admin-button black" onclick="ResearchContentAdmin.openResearch()">Research New Content</button>
        </div>
        ${message ? `<p class="admin-message ${messageTone === "error" ? "admin-error" : messageTone === "success" ? "admin-success" : ""}">${esc(message)}</p>` : ""}
        ${batchRunning ? renderWorkingBanner() : ""}
        <div class="research-filters">
          <label>Entity
            <select onchange="ResearchContentAdmin.setFilter('entity', this.value)">
              <option value="all" ${filterEntity === "all" ? "selected" : ""}>All</option>
              <option value="ship" ${filterEntity === "ship" ? "selected" : ""}>Ships</option>
              <option value="destination" ${filterEntity === "destination" ? "selected" : ""}>Destinations</option>
              <option value="port" ${filterEntity === "port" ? "selected" : ""}>Ports</option>
              <option value="cruise_line" ${filterEntity === "cruise_line" ? "selected" : ""}>Cruise Lines</option>
            </select>
          </label>
          <label>Status
            <select onchange="ResearchContentAdmin.setFilter('status', this.value)">
              <option value="all" ${filterStatus === "all" ? "selected" : ""}>All (hide archived)</option>
              ${Object.keys(STATUS_LABELS)
                .filter((k) => k !== "archived")
                .map(
                  (k) =>
                    `<option value="${k}" ${filterStatus === k ? "selected" : ""}>${STATUS_LABELS[k]}</option>`
                )
                .join("")}
            </select>
          </label>
          <label>Freshness
            <select onchange="ResearchContentAdmin.setFilter('freshness', this.value)">
              <option value="all" ${filterFreshness === "all" ? "selected" : ""}>All</option>
              <option value="current" ${filterFreshness === "current" ? "selected" : ""}>Current</option>
              <option value="review_soon" ${filterFreshness === "review_soon" ? "selected" : ""}>Review Soon</option>
              <option value="overdue" ${filterFreshness === "overdue" ? "selected" : ""}>Overdue</option>
            </select>
          </label>
          <label class="research-search">Search
            <input type="search" value="${esc(searchQuery)}" placeholder="Entity name"
              onkeydown="if(event.key==='Enter'){ResearchContentAdmin.setSearch(this.value)}"
              onchange="ResearchContentAdmin.setSearch(this.value)">
          </label>
        </div>
        ${
          loading
            ? `<p class="admin-muted">Loading…</p>`
            : items.length
              ? `<div class="research-table-wrap">
                  <table class="research-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Type</th>
                        <th>Status</th>
                        <th>Freshness</th>
                        <th>Generated</th>
                        <th>Reviewed</th>
                        <th>Refresh due</th>
                        <th>Sources</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                  </table>
                </div>`
              : `<div class="research-empty"><p>No research content yet.</p><p class="admin-muted">Start with Research New Content to create a reviewed draft.</p></div>`
        }
      </section>
    `;
  }

  function renderResearch() {
    const isCanonical = researchForm.entity_type === "ship" || researchForm.entity_type === "cruise_line";
    const optionsHtml = entityOptions
      .map((e) => {
        const id = e.id || e.entity_key;
        const label = researchOptionLabel(e);
        const selected = researchForm.entity_id === id || researchForm.entity_key === id;
        return `<option value="${esc(id)}" ${selected ? "selected" : ""}>${esc(label)}</option>`;
      })
      .join("");

    const estimate = researchForm.estimate;
    const estimateHtml = estimate
      ? `<div class="research-estimate">
          <h4>Estimated API activity</h4>
          <ul>
            <li>Brave queries: ~${esc(String(estimate.estimated_brave_queries))}</li>
            <li>Source page fetches: ~${esc(String(estimate.estimated_source_fetches))}</li>
            <li>Model requests: ~${esc(String(estimate.estimated_model_requests))}</li>
            <li>Brave configured: ${estimate.brave_search_configured ? "yes" : "no"}</li>
            <li>AI configured: ${estimate.ai_provider_configured ? `${esc(estimate.ai_provider)} / ${esc(estimate.ai_model)}` : "no — set OPENAI_API_KEY"}</li>
          </ul>
        </div>`
      : "";

    const dupHtml = researchForm.duplicates?.length
      ? `<div class="research-duplicate-warn">
          <p><strong>Existing content found.</strong> Use an existing record or confirm to create another draft version.</p>
          <ul>${researchForm.duplicates
            .map(
              (d) =>
                `<li><button type="button" class="admin-button secondary small" onclick="ResearchContentAdmin.openEditor('${esc(d.id)}')">${esc(d.entity_name)} · ${esc(d.content_status)} · v${esc(String(d.content_version))}</button></li>`
            )
            .join("")}</ul>
          <label><input type="checkbox" ${researchForm.confirm_duplicate ? "checked" : ""} onchange="ResearchContentAdmin.setConfirmDuplicate(this.checked)"> Create another draft anyway</label>
        </div>`
      : "";

    const lineOptions = cruiseLinesFromShips()
      .map(
        (line) =>
          `<option value="${esc(line.id)}" ${researchForm.batch_line_id === line.id ? "selected" : ""}>${esc(line.name)}</option>`
      )
      .join("");
    const batchQueue = researchForm.batch_line_id ? batchQueueForLine(researchForm.batch_line_id) : [];
    const batchTotalOnLine = researchForm.batch_line_id ? shipsForBatchLine(researchForm.batch_line_id).length : 0;
    const batchHtml =
      researchForm.entity_type === "ship"
        ? `<div class="research-batch">
            <h3>Batch research by cruise line</h3>
            <p class="admin-muted">Runs one ship at a time (about 30–60 seconds each). Keep this tab open until it finishes.</p>
            <label>Cruise line
              <select onchange="ResearchContentAdmin.setBatchLine(this.value)" ${batchRunning ? "disabled" : ""}>
                <option value="">Choose cruise line…</option>
                ${lineOptions}
              </select>
            </label>
            <label class="research-batch-skip">
              <input type="checkbox" ${researchForm.batch_skip_existing ? "checked" : ""} ${batchRunning ? "disabled" : ""}
                onchange="ResearchContentAdmin.setBatchSkipExisting(this.checked)">
              Skip ships that already have research
            </label>
            <label class="research-batch-skip">
              <input type="checkbox" ${researchForm.batch_auto_publish ? "checked" : ""} ${batchRunning ? "disabled" : ""}
                onchange="ResearchContentAdmin.setBatchAutoPublish(this.checked)">
              Publish automatically after each successful research
            </label>
            ${
              researchForm.batch_line_id
                ? `<p class="admin-muted">${esc(String(batchQueue.length))} ship${batchQueue.length === 1 ? "" : "s"} will run${researchForm.batch_skip_existing ? ` (${esc(String(batchTotalOnLine - batchQueue.length))} skipped)` : ""}. Rough time: ${esc(String(batchQueue.length))}–${esc(String(Math.max(batchQueue.length, batchQueue.length * 2)))} min.</p>`
                : ""
            }
            <div class="research-form-actions research-batch-actions">
              ${
                batchRunning
                  ? `<button type="button" class="admin-button danger" onclick="ResearchContentAdmin.cancelBatch()">Stop after current ship</button>
                     <span class="research-action-status is-busy"><span class="research-spinner research-spinner--inline" aria-hidden="true"></span> Researching, please wait…</span>`
                  : `<button type="button" class="admin-button black" onclick="ResearchContentAdmin.beginBatchResearch()" ${!researchForm.batch_line_id || !batchQueue.length || (linePublishState && linePublishState.status === "publishing") ? "disabled" : ""}>Research line ships</button>
                     ${
                       linePublishState && linePublishState.status === "publishing"
                         ? `<button type="button" class="admin-button secondary is-busy" disabled>
                              <span class="research-spinner research-spinner--inline" aria-hidden="true"></span>
                              Publishing, please wait… ${esc(String(linePublishState.done || 0))}/${esc(String(linePublishState.total || 0))}
                            </button>`
                         : linePublishState && linePublishState.status === "done"
                           ? `<button type="button" class="admin-button secondary" onclick="ResearchContentAdmin.publishLineDrafts()" ${!researchForm.batch_line_id ? "disabled" : ""}>Publish all drafts for this line</button>
                              <span class="research-action-status is-done" role="status">Published${linePublishState.ok != null ? ` (${esc(String(linePublishState.ok))}${linePublishState.fail ? `, ${esc(String(linePublishState.fail))} failed` : ""})` : ""}</span>`
                           : `<button type="button" class="admin-button secondary" onclick="ResearchContentAdmin.publishLineDrafts()" ${!researchForm.batch_line_id || researching ? "disabled" : ""}>Publish all drafts for this line</button>`
                     }`
              }
            </div>
            ${
              linePublishState && linePublishState.status === "publishing"
                ? `<div class="research-working-banner research-working-banner--compact" role="status" aria-live="polite">
                    <div class="research-working-top">
                      <span class="research-spinner" aria-hidden="true"></span>
                      <div>
                        <p class="research-working-title">Publishing drafts${linePublishState.lineName ? ` — ${esc(linePublishState.lineName)}` : ""}</p>
                        <p class="research-working-sub">${esc(String(linePublishState.done || 0))} of ${esc(String(linePublishState.total || 0))} published…</p>
                      </div>
                    </div>
                  </div>`
                : ""
            }
            ${
              batchProgress
                ? `<div class="research-batch-progress ${batchRunning ? "is-running" : ""}">
                    ${
                      batchRunning
                        ? `<p class="research-batch-live"><span class="research-spinner research-spinner--inline" aria-hidden="true"></span> Working… ${esc(String(batchProgress.done))}/${esc(String(batchProgress.total))} · ${esc(batchEtaText())}</p>`
                        : `<p><strong>${esc(String(batchProgress.done))}/${esc(String(batchProgress.total))}</strong> complete</p>`
                    }
                    <ul>${(batchProgress.results || [])
                      .map((r) => {
                        const statusText = r.ok
                          ? r.published
                            ? "published"
                            : "draft saved"
                          : r.error || "failed";
                        const open =
                          r.id
                            ? ` <button type="button" class="admin-button secondary small" onclick="ResearchContentAdmin.openEditor('${esc(r.id)}')">Open</button>`
                            : "";
                        return `<li class="research-batch-${esc(r.ok ? "ok" : "fail")}">${esc(r.name)} — ${esc(statusText)}${open}</li>`;
                      })
                      .join("")}</ul>
                    ${
                      batchRunning && batchProgress.currentName
                        ? `<p class="research-batch-current">Now researching: <strong>${esc(batchProgress.currentName)}</strong></p>`
                        : ""
                    }
                  </div>`
                : ""
            }
          </div>`
        : "";

    return `
      <section class="admin-panel research-panel">
        <div class="admin-panel-header">
          <div>
            <button type="button" class="admin-button secondary small" onclick="ResearchContentAdmin.openList()" ${batchRunning ? "disabled" : ""}>← Back</button>
            <h2>Research New Content</h2>
          </div>
        </div>
        ${message ? `<p class="admin-message ${messageTone === "error" ? "admin-error" : messageTone === "success" ? "admin-success" : ""}">${esc(message)}</p>` : ""}
        ${renderWorkingBanner()}
        <div class="research-form">
          <label>Entity type
            <select onchange="ResearchContentAdmin.setResearchType(this.value)" ${batchRunning || researching ? "disabled" : ""}>
              <option value="ship" ${researchForm.entity_type === "ship" ? "selected" : ""}>Ship</option>
              <option value="destination" ${researchForm.entity_type === "destination" ? "selected" : ""}>Destination</option>
              <option value="port" ${researchForm.entity_type === "port" ? "selected" : ""}>Port</option>
              <option value="cruise_line" ${researchForm.entity_type === "cruise_line" ? "selected" : ""}>Cruise Line</option>
            </select>
          </label>
          ${
            isCanonical
              ? `<label>Select ${ENTITY_LABELS[researchForm.entity_type]}
                  <select onchange="ResearchContentAdmin.setResearchEntityId(this.value)" ${batchRunning ? "disabled" : ""}>
                    <option value="">Choose…</option>
                    ${optionsHtml}
                  </select>
                </label>
                ${selectedEntityResearchNote()}`
              : `<label>Name
                  <input type="text" value="${esc(researchForm.entity_name)}" placeholder="e.g. Greek Isles or Santorini"
                    onchange="ResearchContentAdmin.setResearchName(this.value)" ${batchRunning ? "disabled" : ""}>
                </label>
                <p class="admin-muted">Entity key will normalise to: <code>${esc(researchForm.entity_key || "—")}</code></p>
                ${selectedEntityResearchNote()}
                ${
                  entityOptions.length
                    ? `<label>Or choose existing
                        <select onchange="ResearchContentAdmin.setResearchExistingKey(this.value)" ${batchRunning ? "disabled" : ""}>
                          <option value="">—</option>
                          ${optionsHtml}
                        </select>
                      </label>`
                    : ""
                }`
          }
          ${dupHtml}
          ${estimateHtml}
          <div class="research-form-actions">
            <button type="button" class="admin-button" onclick="ResearchContentAdmin.openList()" ${researching || batchRunning ? "disabled" : ""}>Cancel</button>
            <button type="button" class="admin-button black ${researching ? "is-busy" : ""}" onclick="ResearchContentAdmin.beginResearch()" ${researching || batchRunning ? "disabled" : ""}>
              ${
                researching
                  ? `<span class="research-spinner research-spinner--inline" aria-hidden="true"></span> Researching, please wait…`
                  : "Begin Research"
              }
            </button>
          </div>
          ${researching ? `<p class="admin-muted">Searching sources and generating a draft (usually under ~30 seconds). If it times out, open the Failed row and use Retry Generation.</p>` : ""}
          ${batchHtml}
        </div>
      </section>
    `;
  }

  function changedSections() {
    if (!publishedSibling || !editorDraft?.content_json) return new Set();
    const pub = publishedSibling.content_json || {};
    const draft = editorDraft.content_json || {};
    const changed = new Set();
    const keys = new Set([...Object.keys(pub), ...Object.keys(draft)]);
    for (const key of keys) {
      if (JSON.stringify(pub[key] ?? null) !== JSON.stringify(draft[key] ?? null)) {
        changed.add(key);
      }
    }
    return changed;
  }

  function renderFieldControl(key, label, kind, value) {
    const changed = changedSections().has(key);
    const badge = changed ? `<span class="research-changed">Changed</span>` : "";
    if (kind === "textarea") {
      return `<label class="research-field">${esc(label)} ${badge}
        <textarea rows="4" onchange="ResearchContentAdmin.setField('${esc(key)}', this.value)">${esc(value || "")}</textarea>
      </label>`;
    }
    if (kind === "text") {
      return `<label class="research-field">${esc(label)} ${badge}
        <input type="text" value="${esc(value || "")}" onchange="ResearchContentAdmin.setField('${esc(key)}', this.value)">
      </label>`;
    }
    if (kind === "list") {
      const text = Array.isArray(value) ? value.join("\n") : "";
      return `<label class="research-field">${esc(label)} ${badge}
        <textarea rows="3" placeholder="One item per line" onchange="ResearchContentAdmin.setListField('${esc(key)}', this.value)">${esc(text)}</textarea>
      </label>`;
    }
    if (kind === "faq") {
      const faqs = Array.isArray(value) ? value : [];
      const rows = faqs
        .map(
          (faq, i) => `
          <div class="research-faq-row">
            <input type="text" value="${esc(faq.question || "")}" placeholder="Question"
              onchange="ResearchContentAdmin.setFaq(${i}, 'question', this.value)">
            <textarea rows="2" placeholder="Answer" onchange="ResearchContentAdmin.setFaq(${i}, 'answer', this.value)">${esc(faq.answer || "")}</textarea>
            <button type="button" class="admin-button secondary small" onclick="ResearchContentAdmin.removeFaq(${i})">Remove</button>
          </div>`
        )
        .join("");
      return `<div class="research-field"><div class="research-field-label">${esc(label)} ${badge}
        <button type="button" class="admin-button secondary small" onclick="ResearchContentAdmin.addFaq()">Add FAQ</button></div>
        ${rows || `<p class="admin-muted">No FAQs yet.</p>`}
      </div>`;
    }
    if (kind === "tender") {
      const t = value && typeof value === "object" ? value : { status: "varies", note: "" };
      return `<div class="research-field"><span class="research-field-label">${esc(label)} ${badge}</span>
        <div class="research-tender">
          <select onchange="ResearchContentAdmin.setTender('status', this.value)">
            <option value="yes" ${t.status === "yes" ? "selected" : ""}>Yes</option>
            <option value="no" ${t.status === "no" ? "selected" : ""}>No</option>
            <option value="varies" ${t.status === "varies" ? "selected" : ""}>Varies</option>
          </select>
          <input type="text" value="${esc(t.note || "")}" placeholder="Note / uncertainty"
            onchange="ResearchContentAdmin.setTender('note', this.value)">
        </div>
      </div>`;
    }
    return "";
  }

  function renderEditorActions(item) {
    return `
      <button type="button" class="admin-button" onclick="ResearchContentAdmin.openList()" ${saving ? "disabled" : ""}>Cancel</button>
      <button type="button" class="admin-button" onclick="ResearchContentAdmin.saveDraft()" ${saving ? "disabled" : ""}>Save Draft</button>
      <button type="button" class="admin-button" onclick="ResearchContentAdmin.markReviewed()" ${saving ? "disabled" : ""}>Mark Reviewed</button>
      <button type="button" class="admin-button black" onclick="ResearchContentAdmin.publish()" ${saving || item.content_status === "failed" ? "disabled" : ""}>Publish</button>
      <button type="button" class="admin-button" onclick="ResearchContentAdmin.refreshResearch()" ${saving || researching ? "disabled" : ""}>Refresh Research</button>
      ${item.content_status === "failed" ? `<button type="button" class="admin-button" onclick="ResearchContentAdmin.retryGeneration()" ${saving || researching ? "disabled" : ""}>Retry Generation</button>` : ""}
      <button type="button" class="admin-button danger" onclick="ResearchContentAdmin.archive()" ${saving ? "disabled" : ""}>Delete</button>
    `;
  }

  function renderEditor() {
    if (!editorItem || !editorDraft) return `<p class="admin-muted">Nothing selected.</p>`;
    const item = editorItem;
    const actionButtons = renderEditorActions(item);
    const fields = fieldsFor(item.entity_type)
      .map(([key, label, kind]) => renderFieldControl(key, label, kind, editorDraft.content_json[key]))
      .join("");

    const sourcesHtml = editorSources
      .map(
        (s) => `
      <article class="research-source-card">
        <div class="research-source-top">
          <strong>${esc(s.source_title || s.source_domain || "Source")}</strong>
          <span class="admin-muted">${esc(s.source_domain || "")}</span>
        </div>
        <p class="admin-muted">${esc(s.publisher_name || "")} · Retrieved ${esc(formatDate(s.retrieved_at))}
          ${s.is_primary_source ? " · Primary" : ""} ${s.is_trusted ? " · Trusted" : " · Untrusted"}</p>
        <div class="research-source-actions">
          <a href="${esc(s.source_url)}" target="_blank" rel="noopener noreferrer">Open source</a>
          <label><input type="checkbox" ${s.is_trusted ? "checked" : ""} onchange="ResearchContentAdmin.updateSource('${esc(s.id)}', { is_trusted: this.checked })"> Trusted</label>
          <label><input type="checkbox" ${s.exclude_from_refresh ? "checked" : ""} onchange="ResearchContentAdmin.updateSource('${esc(s.id)}', { exclude_from_refresh: this.checked })"> Exclude from refresh</label>
        </div>
        <input type="text" class="research-source-note" value="${esc(s.notes || "")}" placeholder="Admin note"
          onchange="ResearchContentAdmin.updateSource('${esc(s.id)}', { notes: this.value })">
      </article>`
      )
      .join("");

    const diag = item.diagnostics_json || {};
    const compareHtml = publishedSibling
      ? `<div class="research-compare">
          <h4>Published vs this draft</h4>
          <p class="admin-muted">Sections marked <span class="research-changed">Changed</span> differ from published v${esc(String(publishedSibling.content_version))}.</p>
        </div>`
      : "";

    return `
      <section class="admin-panel research-panel research-editor">
        <div class="admin-panel-header">
          <div>
            <button type="button" class="admin-button secondary small" onclick="ResearchContentAdmin.openList()">← Back</button>
            <h2>${esc(item.entity_name)}</h2>
            <p class="admin-muted">${esc(ENTITY_LABELS[item.entity_type])} · ${esc(STATUS_LABELS[item.content_status])} · ${esc(FRESHNESS_LABELS[item.freshness] || item.freshness)} · v${esc(String(item.content_version))}</p>
          </div>
          <div class="research-editor-header-actions research-editor-actions">
            ${actionButtons}
          </div>
        </div>
        ${message ? `<p class="admin-message ${messageTone === "error" ? "admin-error" : messageTone === "success" ? "admin-success" : ""}">${esc(message)}</p>` : ""}
        <div class="research-editor-meta">
          <span>Generated ${esc(formatDate(item.generated_at))}</span>
          <span>${esc(item.generation_provider || "—")} / ${esc(item.generation_model || "—")}</span>
          <span>${esc(String(item.source_count || 0))} sources</span>
        </div>
        ${item.failure_detail ? `<p class="admin-message admin-message-error">${esc(item.failure_detail)}</p>` : ""}
        ${compareHtml}
        <div class="research-editor-grid">
          <div class="research-editor-fields">
            ${fields}
            <label class="research-field">Paul's Tip <span class="admin-muted">(manual — never overwritten by research)</span>
              <textarea rows="3" onchange="ResearchContentAdmin.setMeta('pauls_tip', this.value)">${esc(editorDraft.pauls_tip || "")}</textarea>
            </label>
            <label class="research-field">SEO title
              <input type="text" value="${esc(editorDraft.seo_title || "")}" onchange="ResearchContentAdmin.setMeta('seo_title', this.value)">
            </label>
            <label class="research-field">Meta description
              <textarea rows="2" onchange="ResearchContentAdmin.setMeta('meta_description', this.value)">${esc(editorDraft.meta_description || "")}</textarea>
            </label>
            <label class="research-field">Canonical slug
              <input type="text" value="${esc(editorDraft.canonical_slug || "")}" onchange="ResearchContentAdmin.setMeta('canonical_slug', this.value)">
            </label>
            <label class="research-field">Media Library ID <span class="admin-muted">(optional image association)</span>
              <input type="text" value="${esc(editorDraft.media_id || "")}" placeholder="UUID from Media Library"
                onchange="ResearchContentAdmin.setMeta('media_id', this.value)">
            </label>
          </div>
          <aside class="research-editor-aside">
            <h3>Sources</h3>
            ${sourcesHtml || `<p class="admin-muted">No sources saved.</p>`}
            <details class="research-diagnostics">
              <summary>Diagnostics</summary>
              <ul>
                <li>Search queries: ${esc(String(diag.search_query_count ?? "—"))}</li>
                <li>Source fetches: ${esc(String(diag.source_fetch_count ?? "—"))}</li>
                <li>Model requests: ${esc(String(diag.model_request_count ?? "—"))}</li>
                <li>Duration: ${esc(diag.duration_ms != null ? `${diag.duration_ms} ms` : "—")}</li>
              </ul>
            </details>
            <details class="research-raw" ${showRawJson ? "open" : ""}>
              <summary onclick="ResearchContentAdmin.toggleRaw()">Raw JSON</summary>
              <pre>${esc(JSON.stringify(editorDraft.content_json, null, 2))}</pre>
            </details>
          </aside>
        </div>
        <div class="research-editor-actions">
          ${actionButtons}
        </div>
      </section>
    `;
  }

  function renderPanel() {
    if (view === "research") return renderResearch();
    if (view === "editor") return renderEditor();
    return renderList();
  }

  const apiPublic = {
    renderPanel,
    ensureLoaded,
    openList,
    openEditor,
    openResearch,
    setFilter(kind, value) {
      if (kind === "entity") filterEntity = value;
      if (kind === "status") filterStatus = value;
      if (kind === "freshness") filterFreshness = value;
      ensureLoaded();
    },
    setSearch(value) {
      searchQuery = String(value || "").trim();
      ensureLoaded();
    },
    async setResearchType(value) {
      researchForm.entity_type = value;
      researchForm.entity_id = "";
      researchForm.entity_name = "";
      researchForm.entity_key = "";
      researchForm.duplicates = [];
      researchForm.confirm_duplicate = false;
      researchForm.batch_line_id = "";
      batchProgress = null;
      await loadEntityOptions(value);
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    setResearchEntityId(value) {
      researchForm.entity_id = value;
      const found = entityOptions.find((e) => e.id === value);
      researchForm.entity_name = found?.name || "";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    setResearchName(value) {
      researchForm.entity_name = value;
      researchForm.entity_key = String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    setResearchExistingKey(value) {
      const found = entityOptions.find((e) => e.entity_key === value);
      if (found) {
        researchForm.entity_key = found.entity_key;
        researchForm.entity_name = found.entity_name;
      }
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    setConfirmDuplicate(checked) {
      researchForm.confirm_duplicate = Boolean(checked);
    },
    setBatchLine(value) {
      researchForm.batch_line_id = value;
      batchProgress = null;
      linePublishState = null;
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    setBatchSkipExisting(checked) {
      researchForm.batch_skip_existing = Boolean(checked);
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    setBatchAutoPublish(checked) {
      researchForm.batch_auto_publish = Boolean(checked);
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    cancelBatch() {
      batchCancelRequested = true;
      message = "Stopping after the current ship finishes…";
      messageTone = "info";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    async publishLineDrafts() {
      if (!researchForm.batch_line_id) return;
      if (linePublishState && linePublishState.status === "publishing") return;

      await loadEntityOptions("ship");
      const ships = shipsForBatchLine(researchForm.batch_line_id).filter(
        (ship) =>
          ship.research_id &&
          (ship.research_status === "draft" || ship.research_status === "reviewed")
      );
      const lineName =
        cruiseLinesFromShips().find((l) => l.id === researchForm.batch_line_id)?.name || "this cruise line";

      if (!ships.length) {
        linePublishState = { status: "empty", lineName };
        message = "No draft/reviewed research found for this cruise line to publish.";
        messageTone = "warning";
        if (typeof global.renderAdmin === "function") global.renderAdmin();
        return;
      }

      linePublishState = {
        status: "publishing",
        total: ships.length,
        done: 0,
        ok: 0,
        fail: 0,
        lineName
      };
      message = `Publishing ${ships.length} draft${ships.length === 1 ? "" : "s"}…`;
      messageTone = "info";
      document.title = `Publishing… · 101cruise Admin`;
      if (typeof global.renderAdmin === "function") global.renderAdmin();

      let ok = 0;
      let fail = 0;
      for (let i = 0; i < ships.length; i += 1) {
        const ship = ships[i];
        try {
          await api("publish", { id: ship.research_id });
          ok += 1;
        } catch {
          fail += 1;
        }
        linePublishState = {
          ...linePublishState,
          status: "publishing",
          done: i + 1,
          ok,
          fail
        };
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }

      await loadEntityOptions("ship");
      linePublishState = {
        status: "done",
        total: ships.length,
        done: ships.length,
        ok,
        fail,
        lineName
      };
      message = `Published ${ok} for ${lineName}${fail ? `, ${fail} failed` : ""}.`;
      messageTone = fail ? "warning" : "success";
      document.title = "101cruise Admin";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    async beginBatchResearch() {
      const queue = batchQueueForLine(researchForm.batch_line_id);
      if (!queue.length) {
        message = "No ships to research for this line with the current skip setting.";
        messageTone = "warning";
        if (typeof global.renderAdmin === "function") global.renderAdmin();
        return;
      }
      const lineName =
        cruiseLinesFromShips().find((l) => l.id === researchForm.batch_line_id)?.name || "this cruise line";
      const autoPublish = researchForm.batch_auto_publish !== false;

      batchRunning = true;
      batchCancelRequested = false;
      batchProgress = {
        total: queue.length,
        done: 0,
        currentName: "",
        results: [],
        startedAt: Date.now(),
        lineName
      };
      message = `Batch research started for ${lineName}.`;
      messageTone = "info";
      document.title = `(0/${queue.length}) Researching… · 101cruise Admin`;
      saveBatchProgress();
      if (typeof global.renderAdmin === "function") global.renderAdmin();

      for (const ship of queue) {
        if (batchCancelRequested) break;
        batchProgress.currentName = ship.name || "Ship";
        document.title = `(${batchProgress.done}/${batchProgress.total}) ${batchProgress.currentName} · 101cruise Admin`;
        saveBatchProgress();
        if (typeof global.renderAdmin === "function") global.renderAdmin();
        try {
          const result = await api(
            "start_research",
            {
              entity_type: "ship",
              entity_id: ship.id,
              entity_name: ship.name,
              confirm_duplicate: true
            },
            "research-content-generate"
          );
          let published = false;
          if (autoPublish && result?.item?.id) {
            try {
              await api("publish", { id: result.item.id });
              published = true;
            } catch (publishError) {
              batchProgress.results.push({
                name: ship.name,
                ok: true,
                published: false,
                id: result.item.id,
                error: `saved but publish failed: ${publishError.message || "error"}`
              });
              batchProgress.done += 1;
              batchProgress.currentName = "";
              saveBatchProgress();
              if (typeof global.renderAdmin === "function") global.renderAdmin();
              continue;
            }
          }
          batchProgress.results.push({
            name: ship.name,
            ok: true,
            published,
            id: result?.item?.id || null
          });
        } catch (error) {
          const errText = error.message || "failed";
          const failedId = error.payload?.item?.id || null;
          batchProgress.results.push({ name: ship.name, ok: false, error: errText, id: failedId });
          if (/quota|billing|OPENAI_API_KEY|503/i.test(errText)) {
            message = `Batch stopped: ${errText}`;
            messageTone = "error";
            batchProgress.done += 1;
            break;
          }
        }
        batchProgress.done += 1;
        batchProgress.currentName = "";
        document.title = `(${batchProgress.done}/${batchProgress.total}) Researching… · 101cruise Admin`;
        saveBatchProgress();
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }

      batchRunning = false;
      batchProgress.currentName = "";
      clearBatchProgressStorage();
      document.title = "101cruise Admin";
      await loadEntityOptions("ship");
      const okCount = (batchProgress.results || []).filter((r) => r.ok).length;
      const publishedCount = (batchProgress.results || []).filter((r) => r.published).length;
      const failCount = (batchProgress.results || []).length - okCount;
      if (batchCancelRequested) {
        message = `Batch stopped early. ${okCount} saved${publishedCount ? ` (${publishedCount} published)` : ""}${failCount ? `, ${failCount} failed` : ""}.`;
        messageTone = "warning";
      } else if (!messageTone || messageTone === "info") {
        message = `Batch complete. ${okCount} saved${autoPublish ? `, ${publishedCount} published` : ""}${failCount ? `, ${failCount} failed` : ""}.${failCount ? " Use Research Content list or Open on failed rows to retry." : ""}`;
        messageTone = failCount ? "warning" : "success";
      }
      batchCancelRequested = false;
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    async beginResearch() {
      message = "";
      researching = true;
      singleResearchStartedAt = Date.now();
      document.title = "Researching… · 101cruise Admin";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
      try {
        if (researchForm.entity_type === "destination" || researchForm.entity_type === "port") {
          const existing = await api("find_existing", {
            entity_type: researchForm.entity_type,
            entity_name: researchForm.entity_name,
            entity_key: researchForm.entity_key
          });
          if (existing.duplicate_warning && !researchForm.confirm_duplicate) {
            researchForm.duplicates = existing.items || [];
            message = "Possible duplicate found — open existing or confirm to continue.";
            messageTone = "warning";
            researching = false;
            document.title = "101cruise Admin";
            if (typeof global.renderAdmin === "function") global.renderAdmin();
            return;
          }
        }

        const payload = {
          action: "start_research",
          entity_type: researchForm.entity_type,
          entity_id: researchForm.entity_id || undefined,
          entity_name: researchForm.entity_name || undefined,
          entity_key: researchForm.entity_key || undefined,
          confirm_duplicate: researchForm.confirm_duplicate,
          refresh_of: researchForm.refresh_of || undefined
        };
        const result = await api("start_research", payload, "research-content-generate");
        message = "Draft researched and saved.";
        messageTone = "success";
        await openEditor(result.item.id);
      } catch (error) {
        if (error.code === "duplicate_entity" && error.payload?.existing) {
          researchForm.duplicates = error.payload.existing;
          message = error.message;
          messageTone = "warning";
        } else if (error.payload?.item?.id) {
          message = error.message || "Research failed — draft saved as Failed.";
          messageTone = "error";
          await openEditor(error.payload.item.id);
        } else if (error.status === 504 || error.status === 502 || error.code === "timeout") {
          message = error.message;
          messageTone = "error";
          await ensureLoaded({ quiet: true }).catch(() => null);
          openList();
        } else {
          message = error.message || "Research failed";
          messageTone = "error";
        }
      } finally {
        researching = false;
        singleResearchStartedAt = null;
        document.title = "101cruise Admin";
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    setField(key, value) {
      if (!editorDraft?.content_json) return;
      editorDraft.content_json[key] = value;
    },
    setListField(key, value) {
      if (!editorDraft?.content_json) return;
      editorDraft.content_json[key] = String(value || "")
        .split("\n")
        .map((v) => v.trim())
        .filter(Boolean);
    },
    setMeta(key, value) {
      if (!editorDraft) return;
      editorDraft[key] = value;
    },
    setFaq(index, field, value) {
      if (!editorDraft?.content_json) return;
      if (!Array.isArray(editorDraft.content_json.frequently_asked_questions)) {
        editorDraft.content_json.frequently_asked_questions = [];
      }
      const row = editorDraft.content_json.frequently_asked_questions[index] || {
        question: "",
        answer: ""
      };
      row[field] = value;
      editorDraft.content_json.frequently_asked_questions[index] = row;
    },
    addFaq() {
      if (!editorDraft?.content_json) return;
      if (!Array.isArray(editorDraft.content_json.frequently_asked_questions)) {
        editorDraft.content_json.frequently_asked_questions = [];
      }
      editorDraft.content_json.frequently_asked_questions.push({ question: "", answer: "" });
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    removeFaq(index) {
      editorDraft.content_json.frequently_asked_questions.splice(index, 1);
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    setTender(field, value) {
      if (!editorDraft?.content_json) return;
      const t = editorDraft.content_json.tender_port || { status: "varies", note: "" };
      t[field] = value;
      editorDraft.content_json.tender_port = t;
    },
    toggleRaw() {
      showRawJson = !showRawJson;
    },
    async saveDraft() {
      saving = true;
      message = "";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
      try {
        const result = await api("save_draft", {
          id: editingId,
          content_json: editorDraft.content_json,
          summary_text: editorDraft.summary_text,
          seo_title: editorDraft.seo_title,
          meta_description: editorDraft.meta_description,
          canonical_slug: editorDraft.canonical_slug,
          pauls_tip: editorDraft.pauls_tip,
          media_id: editorDraft.media_id || null,
          content_status: "draft"
        });
        editorItem = result.item;
        message = "Draft saved.";
        messageTone = "success";
      } catch (error) {
        message = error.message || "Save failed";
        messageTone = "error";
      } finally {
        saving = false;
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async markReviewed() {
      saving = true;
      try {
        await api("save_draft", {
          id: editingId,
          content_json: editorDraft.content_json,
          pauls_tip: editorDraft.pauls_tip,
          seo_title: editorDraft.seo_title,
          meta_description: editorDraft.meta_description,
          canonical_slug: editorDraft.canonical_slug,
          content_status: "reviewed"
        });
        await openEditor(editingId);
        message = "Marked reviewed.";
        messageTone = "success";
      } catch (error) {
        message = error.message || "Could not mark reviewed";
        messageTone = "error";
      } finally {
        saving = false;
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async publishFromList(id) {
      if (!id) return;
      try {
        await api("publish", { id });
        message = "Published.";
        messageTone = "success";
        await ensureLoaded({ quiet: true });
      } catch (error) {
        message = error.message || "Publish failed";
        messageTone = "error";
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async publish() {
      saving = true;
      try {
        await api("save_draft", {
          id: editingId,
          content_json: editorDraft.content_json,
          pauls_tip: editorDraft.pauls_tip,
          seo_title: editorDraft.seo_title,
          meta_description: editorDraft.meta_description,
          canonical_slug: editorDraft.canonical_slug
        });
        await api("publish", { id: editingId });
        message = "Published.";
        messageTone = "success";
        openList();
        await ensureLoaded({ quiet: true });
      } catch (error) {
        message = error.message || "Publish failed";
        messageTone = "error";
      } finally {
        saving = false;
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async archive() {
      saving = true;
      try {
        await api("archive", { id: editingId });
        message = "Deleted.";
        messageTone = "success";
        openList();
        await ensureLoaded({ quiet: true });
      } catch (error) {
        message = error.message || "Delete failed";
        messageTone = "error";
      } finally {
        saving = false;
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async refreshResearch() {
      researching = true;
      message = "Refreshing research…";
      messageTone = "info";
      document.title = "Refreshing research… · 101cruise Admin";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
      try {
        const result = await api(
          "refresh_research",
          {
            entity_type: editorItem.entity_type,
            entity_id: editorItem.entity_id || undefined,
            entity_name: editorItem.entity_name,
            entity_key: editorItem.entity_key || undefined,
            refresh_of: editingId,
            confirm_duplicate: true
          },
          "research-content-generate"
        );
        message = "New research draft created.";
        messageTone = "success";
        await openEditor(result.item.id);
      } catch (error) {
        message = error.message || "Refresh failed";
        messageTone = "error";
        if (error.payload?.item?.id) await openEditor(error.payload.item.id);
      } finally {
        researching = false;
        document.title = "101cruise Admin";
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async retryGeneration() {
      researching = true;
      message = "Retrying generation from saved sources…";
      messageTone = "info";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
      try {
        const result = await api("retry_generation", { id: editingId }, "research-content-generate");
        message = "Generation retry succeeded.";
        messageTone = "success";
        await openEditor(result.item.id);
      } catch (error) {
        message = error.message || "Retry failed";
        messageTone = "error";
      } finally {
        researching = false;
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    },
    async updateSource(sourceId, patch) {
      try {
        const result = await api("update_source", { source_id: sourceId, ...patch });
        const idx = editorSources.findIndex((s) => s.id === sourceId);
        if (idx >= 0) editorSources[idx] = result.source;
      } catch (error) {
        message = error.message || "Could not update source";
        messageTone = "error";
        if (typeof global.renderAdmin === "function") global.renderAdmin();
      }
    }
  };

  global.ResearchContentAdmin = apiPublic;
})(typeof window !== "undefined" ? window : globalThis);
