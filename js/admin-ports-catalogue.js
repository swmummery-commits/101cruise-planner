/**
 * Admin Ports catalogue — browse / add / edit / delete.
 * Uses /.netlify/functions/ports-catalogue (service role) to avoid RLS traps.
 * Browser global: PortsCatalogueAdmin
 */
(function (global) {
  "use strict";

  let ports = [];
  let loading = false;
  let saving = false;
  let message = "";
  let messageTone = "";
  let searchQuery = "";
  let statusFilter = "all";
  let coordsFilter = "all";
  let searchDebounce = null;
  let selectedId = null;
  let creating = false;
  let draft = emptyDraft();
  let imageLoading = false;
  let imageCandidates = [];
  let bulkRunning = false;
  let bulkSummary = null;

  function emptyDraft() {
    return {
      canonical_name: "",
      display_name: "",
      city: "",
      country: "",
      country_code: "",
      region: "",
      latitude: "",
      longitude: "",
      aliases: "",
      status: "provisional",
      source: "admin",
      source_url: ""
    };
  }

  function esc(value) {
    return typeof global.esc === "function"
      ? global.esc(value)
      : String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#039;");
  }

  function rerender() {
    if (typeof global.renderAdmin === "function") global.renderAdmin();
  }

  function setMessage(text, tone) {
    message = text || "";
    messageTone = tone || "";
  }

  function withSavingOverlay(fn, supportMessage) {
    const loading = global.AdminLoading;
    if (loading?.withSaving) {
      return loading.withSaving(fn, {
        key: "ports-catalogue",
        supportMessage: supportMessage || ""
      });
    }
    return fn();
  }

  async function imageApi(action, extra = {}) {
    const headers =
      typeof global.adminAuthHeaders === "function"
        ? await global.adminAuthHeaders({ "Content-Type": "application/json" })
        : { "Content-Type": "application/json" };
    const response = await fetch("/.netlify/functions/port-image-finder", {
      method: "POST",
      headers,
      body: JSON.stringify({ action, ...extra })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      const err = new Error(data.error || `Port image finder failed (HTTP ${response.status})`);
      err.statusCode = response.status;
      throw err;
    }
    return data;
  }

  function syncPortImageState(port) {
    imageCandidates = Array.isArray(port?.image_candidates) ? port.image_candidates : [];
  }

  function imageStatusLabel(status) {
    const s = String(status || "").toUpperCase();
    if (s === "MANUAL") return "Manual";
    if (s === "AUTO_APPROVED") return "Auto-approved";
    if (s === "NEEDS_REVIEW") return "Needs review";
    if (s === "NO_IMAGE") return "No image";
    return "Not searched";
  }

  function hasPortImage(port) {
    return Boolean(
      port?.hero_media_id &&
        ["MANUAL", "AUTO_APPROVED"].includes(String(port?.image_status || "").toUpperCase())
    );
  }

  async function findPortImage({ force = false } = {}) {
    const port = selectedPort();
    if (!port?.id) return;

    return withSavingOverlay(async function () {
      imageLoading = true;
      setMessage("Searching for port images…", "running");
      rerender();
      try {
        const data = await imageApi("find_candidates", { port_id: port.id, force });
        if (data.port?.id) {
          const idx = ports.findIndex((p) => p.id === data.port.id);
          if (idx >= 0) ports[idx] = { ...ports[idx], ...data.port };
          if (selectedId === data.port.id) draft = portToDraft(data.port);
        }
        imageCandidates = Array.isArray(data.candidates) ? data.candidates : [];
        if (data.skipped) {
          setMessage(`Search skipped: ${data.reason || "already set"}.`, "info");
        } else if (!imageCandidates.length) {
          setMessage("No suitable port images found. Try again later or upload manually via Media Library.", "info");
        } else {
          setMessage(`Found ${imageCandidates.length} candidate${imageCandidates.length === 1 ? "" : "s"}.`, "success");
        }
      } catch (error) {
        setMessage(error.message || "Could not search for port images.", "error");
      } finally {
        imageLoading = false;
        rerender();
      }
    }, "Searching for port images…");
  }

  function hasStoredReviewImage(port) {
    return Boolean(
      port?.hero_media_id && String(port?.image_status || "").toUpperCase() === "NEEDS_REVIEW"
    );
  }

  async function approveReviewedPortImage() {
    const port = selectedPort();
    if (!port?.id || !hasStoredReviewImage(port)) return;

    return withSavingOverlay(async function () {
      imageLoading = true;
      setMessage("Approving image for Explore display…", "running");
      rerender();
      try {
        const data = await imageApi("approve_reviewed", { port_id: port.id });
        if (data.port?.id) {
          const idx = ports.findIndex((p) => p.id === data.port.id);
          if (idx >= 0) ports[idx] = { ...ports[idx], ...data.port };
          draft = portToDraft(data.port);
        }
        setMessage("Image approved for Explore display. Status is now Manual and protected from overwrite.", "success");
      } catch (error) {
        setMessage(error.message || "Could not approve image.", "error");
      } finally {
        imageLoading = false;
        rerender();
      }
    }, "Approving image…");
  }

  async function applyPortImageCandidate(candidate) {
    const port = selectedPort();
    if (!port?.id || !candidate) return;

    return withSavingOverlay(async function () {
      imageLoading = true;
      setMessage("Saving port image…", "running");
      rerender();
      try {
        const data = await imageApi("apply_candidate", {
          port_id: port.id,
          candidate,
          image_status: "MANUAL",
          search_query: port.image_search_query || null
        });
        if (data.port?.id) {
          const idx = ports.findIndex((p) => p.id === data.port.id);
          if (idx >= 0) ports[idx] = { ...ports[idx], ...data.port };
          draft = portToDraft(data.port);
        }
        imageCandidates = [];
        setMessage("Port image saved.", "success");
      } catch (error) {
        setMessage(error.message || "Could not save port image.", "error");
      } finally {
        imageLoading = false;
        rerender();
      }
    }, "Saving port image…");
  }

  function applyPortImageCandidateByIndex(index) {
    const port = selectedPort();
    const list = imageCandidates.length ? imageCandidates : port?.image_candidates || [];
    const candidate = list[Number(index)];
    if (!candidate) return;
    return applyPortImageCandidate(candidate);
  }

  async function findPortImageAgain() {
    return findPortImage({ force: true });
  }

  async function bulkFindMissingPortImages() {
    const confirmed = window.confirm(
      "Find missing port images in batches?\n\nManual images are never overwritten. Recently searched ports may be skipped."
    );
    if (!confirmed) return;

    bulkRunning = true;
    bulkSummary = { auto_approved: 0, needs_review: 0, no_image: 0, skipped: 0, errors: 0, processed: 0 };
    setMessage("Starting bulk port image search…", "running");
    rerender();

    let offset = 0;
    let hasMore = true;

    try {
      while (hasMore) {
        setMessage(`Bulk search in progress… (${bulkSummary.processed} ports processed)`, "running");
        rerender();
        const data = await imageApi("bulk_missing", { offset, limit: 5, auto_apply: true });
        const summary = data.summary || {};
        bulkSummary.auto_approved += summary.auto_approved || 0;
        bulkSummary.needs_review += summary.needs_review || 0;
        bulkSummary.no_image += summary.no_image || 0;
        bulkSummary.skipped += summary.skipped || 0;
        bulkSummary.errors += summary.errors || 0;
        bulkSummary.processed += summary.processed || 0;
        offset = data.next_offset || offset + (data.batch_size || 0);
        hasMore = Boolean(data.has_more) && (data.batch_size || 0) > 0;
        if ((data.batch_size || 0) === 0) hasMore = false;
      }
      await ensureLoaded({ force: true, quiet: true });
      setMessage(
        `Bulk complete — ${bulkSummary.auto_approved} auto-approved, ${bulkSummary.needs_review} need review, ${bulkSummary.no_image} no suitable image, ${bulkSummary.skipped} skipped.`,
        "success"
      );
    } catch (error) {
      setMessage(error.message || "Bulk port image search failed.", "error");
    } finally {
      bulkRunning = false;
      rerender();
    }
  }

  async function api(action, extra = {}) {
    const headers =
      typeof global.adminAuthHeaders === "function"
        ? await global.adminAuthHeaders({ "Content-Type": "application/json" })
        : { "Content-Type": "application/json" };
    const response = await fetch("/.netlify/functions/ports-catalogue", {
      method: "POST",
      headers,
      body: JSON.stringify({ action, ...extra })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      const err = new Error(data.error || `Ports catalogue failed (HTTP ${response.status})`);
      err.statusCode = response.status;
      throw err;
    }
    return data;
  }

  function syncItineraryPortsCache() {
    if (typeof global.FeaturedItineraryEditor?.ensurePortsLoaded === "function") {
      global.FeaturedItineraryEditor.ensurePortsLoaded({ force: true }).catch(() => {});
    }
  }

  function portToDraft(port) {
    const aliases = Array.isArray(port?.aliases) ? port.aliases : [];
    return {
      canonical_name: port?.canonical_name || "",
      display_name: port?.display_name || "",
      city: port?.city || "",
      country: port?.country || "",
      country_code: port?.country_code || "",
      region: port?.region || "",
      latitude: port?.latitude == null || port?.latitude === "" ? "" : String(port.latitude),
      longitude: port?.longitude == null || port?.longitude === "" ? "" : String(port.longitude),
      aliases: aliases.join(" | "),
      status: port?.status || "provisional",
      source: port?.source || "admin",
      source_url: port?.source_url || ""
    };
  }

  function readDraftFromDom() {
    const get = (id) => document.getElementById(id)?.value ?? "";
    draft = {
      canonical_name: String(get("portCanonicalName") || "").trim(),
      display_name: String(get("portDisplayName") || "").trim(),
      city: String(get("portCity") || "").trim(),
      country: String(get("portCountry") || "").trim(),
      country_code: String(get("portCountryCode") || "").trim().toUpperCase(),
      region: String(get("portRegion") || "").trim(),
      latitude: String(get("portLatitude") || "").trim(),
      longitude: String(get("portLongitude") || "").trim(),
      aliases: String(get("portAliases") || "").trim(),
      status: String(get("portStatus") || "provisional").trim(),
      source: String(get("portSource") || "admin").trim(),
      source_url: String(get("portSourceUrl") || "").trim()
    };
    return draft;
  }

  function draftPayload() {
    return {
      ...draft,
      aliases: draft.aliases,
      latitude: draft.latitude === "" ? null : draft.latitude,
      longitude: draft.longitude === "" ? null : draft.longitude
    };
  }

  function hasMissingCoords(port) {
    return port?.latitude == null || port?.longitude == null || port.latitude === "" || port.longitude === "";
  }

  function filteredPorts() {
    const q = searchQuery.trim().toLowerCase();
    return ports.filter((port) => {
      if (statusFilter !== "all" && port.status !== statusFilter) return false;
      if (coordsFilter === "missing" && !hasMissingCoords(port)) return false;
      if (coordsFilter === "has" && hasMissingCoords(port)) return false;
      if (!q) return true;
      const aliases = Array.isArray(port.aliases) ? port.aliases.join(" ") : "";
      const hay = [
        port.canonical_name,
        port.display_name,
        port.city,
        port.country,
        port.country_code,
        port.region,
        aliases,
        port.match_key
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }

  function statusLabel(status) {
    if (status === "verified") return "Verified";
    if (status === "needs_review") return "Needs review";
    return "Provisional";
  }

  function selectedPort() {
    if (creating || !selectedId) return null;
    return ports.find((p) => p.id === selectedId) || null;
  }

  function loadingPanel() {
    if (global.BrandLoading?.panelHtml) return global.BrandLoading.panelHtml();
    return `<p class="admin-muted">Hang tight! Just getting your info.</p>`;
  }

  async function ensureLoaded({ force = false, quiet = false } = {}) {
    if (ports.length && !force && !loading) return ports;
    const load = async () => {
      const data = await api("list");
      ports = Array.isArray(data.ports) ? data.ports : [];
      if (!ports.length) {
        setMessage("Ports catalogue is empty. Add the first port, or apply the seed migration in Supabase.", "info");
      }
    };
    loading = true;
    if (!quiet) {
      setMessage("");
      rerender();
    }
    try {
      if (typeof global.AdminLoading?.withLoading === "function") {
        await global.AdminLoading.withLoading(load, { key: "ports-catalogue", delayMs: 0 });
      } else {
        await load();
      }
    } catch (error) {
      ports = [];
      setMessage(error.message || "Could not load the Ports catalogue.", "error");
    } finally {
      loading = false;
      rerender();
    }
    return ports;
  }

  function setSearch(value) {
    searchQuery = value;
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      searchDebounce = null;
      refreshMasterListOnly();
    }, 80);
  }

  function refreshMasterListOnly() {
    const list = typeof document !== "undefined" ? document.getElementById("portsMasterList") : null;
    const count = typeof document !== "undefined" ? document.getElementById("portsListCount") : null;
    const filtered = filteredPorts();
    if (count) {
      count.textContent = loading ? "Hang tight! Just getting your info." : `${filtered.length} of ${ports.length} ports`;
    }
    if (!list) {
      rerender();
      return;
    }
    if (loading) {
      list.innerHTML = loadingPanel();
      return;
    }
    list.innerHTML = filtered.length
      ? filtered.map(renderMasterRow).join("")
      : `<p class="admin-small ci-master-empty">No ports match these filters.</p>`;
  }

  function setStatusFilter(value) {
    statusFilter = value || "all";
    rerender();
  }

  function setCoordsFilter(value) {
    coordsFilter = value || "all";
    rerender();
  }

  async function flushBeforeSwitch() {
    if (!(creating || selectedId) || saving) return true;
    // Autosave only when there is something to keep (named port).
    readDraftFromDom();
    if (!String(draft.canonical_name || "").trim()) return true;
    try {
      await savePort({ quiet: true });
      return true;
    } catch (_error) {
      rerender();
      return false;
    }
  }

  async function startCreate(prefill = {}) {
    const ok = await flushBeforeSwitch();
    if (!ok) return;
    creating = true;
    selectedId = null;
    draft = { ...emptyDraft(), ...(prefill && typeof prefill === "object" ? prefill : {}) };
    setMessage("");
    rerender();
    window.setTimeout(() => document.getElementById("portCanonicalName")?.focus(), 40);
  }

  async function selectPort(id) {
    if (!creating && selectedId === id) return;
    const ok = await flushBeforeSwitch();
    if (!ok) return;
    const port = ports.find((p) => p.id === id);
    if (!port) return;
    creating = false;
    selectedId = id;
    draft = portToDraft(port);
    syncPortImageState(port);
    setMessage("");
    rerender();
  }

  function cancelEdit() {
    creating = false;
    selectedId = null;
    draft = emptyDraft();
    imageCandidates = [];
    setMessage("");
    rerender();
  }

  async function savePort({ quiet = false } = {}) {
    readDraftFromDom();
    if (!String(draft.canonical_name || "").trim()) {
      setMessage("Canonical name is required.", "error");
      if (!quiet) rerender();
      throw new Error("Canonical name is required.");
    }

    const performSave = async function () {
      saving = true;
      if (!quiet) {
        setMessage("Saving…", "running");
        rerender();
      }

      try {
        const payload = draftPayload();
        let result;
        if (creating || !selectedId) {
          result = await api("create", { port: payload });
        } else {
          result = await api("update", { id: selectedId, port: payload });
        }
        const port = result.port;
        if (!port?.id) throw new Error("Port was not returned after save.");

        const idx = ports.findIndex((p) => p.id === port.id);
        if (idx >= 0) ports[idx] = port;
        else ports.push(port);
        ports.sort((a, b) =>
          String(a.canonical_name || "").localeCompare(String(b.canonical_name || ""), undefined, {
            sensitivity: "base"
          })
        );

        creating = false;
        selectedId = port.id;
        draft = portToDraft(port);
        syncItineraryPortsCache();
        if (!quiet) setMessage(`Saved “${port.display_name || port.canonical_name}”.`, "success");
        return port;
      } catch (error) {
        setMessage(error.message || "Could not save port.", "error");
        throw error;
      } finally {
        saving = false;
        if (!quiet) rerender();
      }
    };

    if (!quiet) {
      return withSavingOverlay(performSave, "Saving port…");
    }
    return performSave();
  }

  async function deleteSelectedPort() {
    const port = selectedPort();
    if (!port?.id) return;
    const label = port.display_name || port.canonical_name || "this port";
    const confirmed = window.confirm(
      `Delete “${label}” from the Ports catalogue?\n\nItinerary stops linked to this port will keep their text but lose the catalogue link.`
    );
    if (!confirmed) return;

    return withSavingOverlay(async function () {
      saving = true;
      setMessage("Deleting…", "running");
      rerender();
      try {
        await api("delete", { id: port.id });
        ports = ports.filter((p) => p.id !== port.id);
        creating = false;
        selectedId = null;
        draft = emptyDraft();
        syncItineraryPortsCache();
        setMessage(`Deleted “${label}”.`, "success");
      } catch (error) {
        setMessage(error.message || "Could not delete port.", "error");
      } finally {
        saving = false;
        rerender();
      }
    }, "Deleting port…");
  }

  function renderMasterRow(port) {
    const selected = !creating && selectedId === port.id;
    const missing = hasMissingCoords(port);
    const meta = [
      port.country || null,
      statusLabel(port.status),
      missing ? "No coords" : null
    ]
      .filter(Boolean)
      .join(" · ");
    return `
      <button type="button" class="ci-master-row ${selected ? "is-selected" : ""}" onclick="PortsCatalogueAdmin.selectPort('${esc(port.id)}')">
        <span class="ci-master-row-title">${esc(port.display_name || port.canonical_name)}</span>
        <span class="ci-master-row-meta">${esc(meta)}</span>
      </button>`;
  }

  function renderImageSection(port) {
    if (creating || !port) return "";

    const hasImage = hasPortImage(port);
    const pendingReview = hasStoredReviewImage(port);
    const status = imageStatusLabel(port.image_status);
    const confidence =
      port.image_confidence != null && port.image_confidence !== ""
        ? `${Math.round(Number(port.image_confidence))}%`
        : "";
    const checked = port.image_last_checked_at
      ? new Date(port.image_last_checked_at).toLocaleString()
      : "";

    const currentBlock = hasImage
      ? `
        <div class="ports-image-current">
          <p class="admin-small"><strong>Status:</strong> ${esc(status)}${confidence ? ` · <strong>Confidence:</strong> ${esc(confidence)}` : ""}</p>
          <p class="admin-small"><strong>Source:</strong> ${esc(port.image_source || "—")}</p>
          ${port.image_license ? `<p class="admin-small"><strong>Licence:</strong> ${esc(port.image_license)}</p>` : ""}
          ${port.image_credit ? `<p class="admin-small"><strong>Credit:</strong> ${esc(port.image_credit)}</p>` : ""}
          ${
            port.image_source_url
              ? `<p class="admin-small"><strong>Source page:</strong> <a href="${esc(port.image_source_url)}" target="_blank" rel="noopener noreferrer">View source</a></p>`
              : ""
          }
          ${checked ? `<p class="admin-small"><strong>Last checked:</strong> ${esc(checked)}</p>` : ""}
        </div>`
      : pendingReview
        ? `
        <div class="ports-image-current">
          <p class="admin-small"><strong>Status:</strong> ${esc(status)} — stored but <strong>not public</strong> until approved.</p>
          <p class="admin-muted admin-small" style="margin:8px 0">An image was found automatically and saved for review. Approve it to show on Cruise Finder Explore pages.</p>
          <p class="admin-small"><strong>Source:</strong> ${esc(port.image_source || "—")}</p>
          ${port.image_license ? `<p class="admin-small"><strong>Licence:</strong> ${esc(port.image_license)}</p>` : ""}
          ${port.image_credit ? `<p class="admin-small"><strong>Credit:</strong> ${esc(port.image_credit)}</p>` : ""}
          ${
            port.image_source_url
              ? `<p class="admin-small"><strong>Source page:</strong> <a href="${esc(port.image_source_url)}" target="_blank" rel="noopener noreferrer">View source</a></p>`
              : ""
          }
          <button type="button" class="admin-button black small" style="margin-top:8px" onclick="PortsCatalogueAdmin.approveReviewedPortImage()" ${imageLoading || saving ? "disabled" : ""}>Approve for Explore</button>
        </div>`
        : `<p class="admin-muted admin-small" style="margin:0 0 12px">No port-specific image yet. Country images are not used as a fallback on Explore pages.</p>`;

    const candidates = (imageCandidates.length ? imageCandidates : port.image_candidates || [])
      .slice(0, 8)
      .map((candidate, index) => {
        const dims =
          candidate.width && candidate.height ? `${candidate.width}×${candidate.height}` : "";
        return `
          <article class="ports-image-candidate">
            <div class="ports-image-candidate-thumb">
              ${
                candidate.thumbUrl || candidate.url
                  ? `<img src="${esc(candidate.thumbUrl || candidate.url)}" alt="" loading="lazy">`
                  : `<span class="admin-muted admin-small">No preview</span>`
              }
            </div>
            <div class="ports-image-candidate-meta">
              <p class="admin-small"><strong>${esc(candidate.provider || "unknown")}</strong>${
                candidate.geographic != null || candidate.suitability != null || candidate.confidence != null
                  ? ` · Geo ${esc(String(candidate.geographic ?? "—"))}% · Suit ${esc(String(candidate.suitability ?? "—"))}% · Overall ${esc(String(candidate.confidence ?? "—"))}%`
                  : candidate.confidence != null
                    ? ` · ${esc(String(candidate.confidence))}%`
                    : ""
              }</p>
              <p class="admin-small">${esc(candidate.title || candidate.description || "Untitled")}</p>
              ${dims ? `<p class="admin-small">${esc(dims)}</p>` : ""}
              ${candidate.license ? `<p class="admin-small">Licence: ${esc(candidate.license)}</p>` : ""}
              ${
                candidate.sourceUrl
                  ? `<p class="admin-small"><a href="${esc(candidate.sourceUrl)}" target="_blank" rel="noopener noreferrer">Source</a></p>`
                  : ""
              }
              <button type="button" class="admin-button black small" onclick="PortsCatalogueAdmin.applyPortImageCandidateByIndex(${index})" ${imageLoading || saving ? "disabled" : ""}>Use image</button>
            </div>
          </article>`;
      })
      .join("");

    return `
      <div class="ports-image-panel admin-card" style="margin-top:20px;padding:16px">
        <h4 style="margin:0 0 8px">Port image</h4>
        <p class="admin-muted admin-small" style="margin:0 0 12px">Port-specific imagery for Cruise Finder Explore pages. Searches Wikimedia Commons first, then Pexels (if configured), then Brave for discovery.</p>
        ${currentBlock}
        <div class="admin-actions-row" style="gap:8px;flex-wrap:wrap;margin:12px 0">
          <button type="button" class="admin-button black small" onclick="PortsCatalogueAdmin.findPortImage()" ${imageLoading || saving || bulkRunning ? "disabled" : ""}>${imageLoading ? "Searching…" : "Find image"}</button>
          <button type="button" class="admin-button secondary small" onclick="PortsCatalogueAdmin.findPortImageAgain()" ${imageLoading || saving || bulkRunning ? "disabled" : ""}>Search again</button>
        </div>
        ${
          candidates
            ? `<div class="ports-image-candidates">${candidates}</div>`
            : port.image_status === "NEEDS_REVIEW" && !imageCandidates.length
              ? `<p class="admin-small admin-muted">Candidates were saved previously but are not shown in this session. Click Find image to refresh.</p>`
              : ""
        }
      </div>`;
  }

  function renderForm() {
    const port = selectedPort();
    const title = creating ? "New port" : port?.display_name || port?.canonical_name || "Port";
    const subtitle = creating
      ? "Add a canonical port for itinerary matching and route maps."
      : port?.match_key
        ? `Match key: ${port.match_key}`
        : "Edit catalogue fields, then save.";

    return `
      <div class="ci-detail-title-row">
        <div>
          <h4 class="ci-detail-title">${esc(title)}</h4>
          <p class="ci-detail-subtitle">${esc(subtitle)}</p>
        </div>
      </div>
      <div class="ci-form-grid ports-form-grid">
        <div class="admin-field">
          <label for="portCanonicalName">Canonical name <span class="admin-required">*</span></label>
          <input id="portCanonicalName" type="text" value="${esc(draft.canonical_name)}" ${saving ? "disabled" : ""}>
        </div>
        <div class="admin-field">
          <label for="portDisplayName">Display name</label>
          <input id="portDisplayName" type="text" value="${esc(draft.display_name)}" ${saving ? "disabled" : ""}>
        </div>
        <div class="admin-field">
          <label for="portCity">City</label>
          <input id="portCity" type="text" value="${esc(draft.city)}" ${saving ? "disabled" : ""}>
        </div>
        <div class="admin-field">
          <label for="portCountry">Country</label>
          <input id="portCountry" type="text" value="${esc(draft.country)}" ${saving ? "disabled" : ""}>
        </div>
        <div class="admin-field">
          <label for="portCountryCode">Country code</label>
          <input id="portCountryCode" type="text" maxlength="3" value="${esc(draft.country_code)}" placeholder="AU" ${saving ? "disabled" : ""}>
        </div>
        <div class="admin-field">
          <label for="portRegion">Region</label>
          <input id="portRegion" type="text" value="${esc(draft.region)}" ${saving ? "disabled" : ""}>
        </div>
        <div class="admin-field">
          <label for="portLatitude">Latitude</label>
          <input id="portLatitude" type="number" step="any" value="${esc(draft.latitude)}" ${saving ? "disabled" : ""}>
        </div>
        <div class="admin-field">
          <label for="portLongitude">Longitude</label>
          <input id="portLongitude" type="number" step="any" value="${esc(draft.longitude)}" ${saving ? "disabled" : ""}>
        </div>
        <div class="admin-field featured-span-2">
          <label for="portAliases">Aliases</label>
          <input id="portAliases" type="text" value="${esc(draft.aliases)}" placeholder="Rome | Roma | Civitavecchia" ${saving ? "disabled" : ""}>
          <div class="admin-helper">Separate with | or commas. Used for itinerary matching.</div>
        </div>
        <div class="admin-field">
          <label for="portStatus">Status</label>
          <select id="portStatus" ${saving ? "disabled" : ""}>
            <option value="verified" ${draft.status === "verified" ? "selected" : ""}>Verified</option>
            <option value="provisional" ${draft.status === "provisional" ? "selected" : ""}>Provisional</option>
            <option value="needs_review" ${draft.status === "needs_review" ? "selected" : ""}>Needs review</option>
          </select>
        </div>
        <div class="admin-field">
          <label for="portSource">Source</label>
          <input id="portSource" type="text" value="${esc(draft.source)}" ${saving ? "disabled" : ""}>
        </div>
        <div class="admin-field featured-span-2">
          <label for="portSourceUrl">Source URL</label>
          <input id="portSourceUrl" type="url" value="${esc(draft.source_url)}" placeholder="https://" ${saving ? "disabled" : ""}>
        </div>
      </div>
      <div class="admin-actions-row" style="margin-top:16px;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <div class="admin-actions-row" style="gap:8px">
          <button type="button" class="admin-button black" onclick="PortsCatalogueAdmin.savePort()" ${saving ? "disabled" : ""}>${saving ? "Saving…" : creating ? "Create port" : "Save changes"}</button>
          <button type="button" class="admin-button secondary" onclick="PortsCatalogueAdmin.cancelEdit()" ${saving ? "disabled" : ""}>Cancel</button>
        </div>
        ${
          !creating && selectedId
            ? `<button type="button" class="admin-button secondary" onclick="PortsCatalogueAdmin.deleteSelectedPort()" ${saving ? "disabled" : ""}>Delete port</button>`
            : ""
        }
      </div>
      ${renderImageSection(port)}
    `;
  }

  function renderPanel() {
    const filtered = filteredPorts();
    const showDetail = creating || Boolean(selectedPort());
    const msgClass =
      messageTone === "error"
        ? "admin-error"
        : messageTone === "success"
          ? "admin-success"
          : messageTone === "running"
            ? "admin-running"
            : "";

    return `
      <div class="admin-card">
        <div class="admin-list-top">
          <div>
            <p class="admin-nav-eyebrow">Cruise Database</p>
            <h3>Ports</h3>
            <p class="admin-muted">Canonical ports catalogue for itinerary matching and route maps. Changes save when you create/update, or when you switch to another port.</p>
          </div>
        </div>
        ${message ? `<div class="admin-message ${msgClass}">${esc(message)}</div>` : ""}
        <div class="ci-toolbar">
          <div class="ci-toolbar-controls">
            <input id="portsSearchInput" type="search" value="${esc(searchQuery)}" placeholder="Search ports…" oninput="PortsCatalogueAdmin.setSearch(this.value)" autocomplete="off">
            <select onchange="PortsCatalogueAdmin.setStatusFilter(this.value)">
              <option value="all" ${statusFilter === "all" ? "selected" : ""}>All statuses</option>
              <option value="verified" ${statusFilter === "verified" ? "selected" : ""}>Verified</option>
              <option value="provisional" ${statusFilter === "provisional" ? "selected" : ""}>Provisional</option>
              <option value="needs_review" ${statusFilter === "needs_review" ? "selected" : ""}>Needs review</option>
            </select>
            <select onchange="PortsCatalogueAdmin.setCoordsFilter(this.value)">
              <option value="all" ${coordsFilter === "all" ? "selected" : ""}>All coords</option>
              <option value="missing" ${coordsFilter === "missing" ? "selected" : ""}>Missing coords</option>
              <option value="has" ${coordsFilter === "has" ? "selected" : ""}>Has coords</option>
            </select>
            <button type="button" class="admin-button black small" onclick="PortsCatalogueAdmin.startCreate()" ${saving || loading || bulkRunning ? "disabled" : ""}>Add port</button>
            <button type="button" class="admin-button secondary small" onclick="PortsCatalogueAdmin.bulkFindMissingPortImages()" ${saving || loading || bulkRunning || imageLoading ? "disabled" : ""}>${bulkRunning ? "Bulk search running…" : "Find missing port images"}</button>
          </div>
          <div class="admin-small"><span id="portsListCount">${loading ? "Hang tight! Just getting your info." : `${filtered.length} of ${ports.length} ports`}</span></div>
        </div>
        <div class="ci-master-detail">
          <aside class="ci-master" aria-label="Ports">
            <div class="ci-master-header"><span>Ports</span></div>
            <div class="ci-master-list" id="portsMasterList">
              ${
                loading
                  ? loadingPanel()
                  : filtered.length
                    ? filtered.map(renderMasterRow).join("")
                    : `<p class="admin-small ci-master-empty">No ports match these filters.</p>`
              }
            </div>
          </aside>
          <section class="ci-detail" aria-label="Port details">
            ${
              showDetail
                ? renderForm()
                : `<div class="ci-detail-empty"><p class="admin-muted" style="margin:0;">Select a port to view and edit, or add a new one.</p></div>`
            }
          </section>
        </div>
      </div>
    `;
  }

  global.PortsCatalogueAdmin = {
    renderPanel,
    ensureLoaded,
    setSearch,
    setStatusFilter,
    setCoordsFilter,
    startCreate,
    selectPort,
    cancelEdit,
    savePort,
    deleteSelectedPort,
    findPortImage,
    findPortImageAgain,
    applyPortImageCandidate,
    applyPortImageCandidateByIndex,
    approveReviewedPortImage,
    bulkFindMissingPortImages
  };
})(typeof window !== "undefined" ? window : globalThis);
