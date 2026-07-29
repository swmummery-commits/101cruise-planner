/**
 * Newsletter Issue Composer — Create Social Pack modal (destination-first).
 */
(function (global) {
  "use strict";

  let open = false;
  let busy = false;
  let issueNumber = null;
  let cruises = [];
  let previewId = null;
  let preview = null;
  let message = "";
  let messageTone = "";
  let treatment = "soft";
  let socialMediaId = null;
  let imagePickerOpen = false;
  let imagePickerTab = "recommended";

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
    throw new Error("Admin authentication is not available.");
  }

  function selectedIds() {
    return cruises.filter((c) => c.selected && c.readiness?.status !== "blocked").map((c) => c.id);
  }

  function selectedReady() {
    return cruises.filter((c) => c.selected && c.readiness?.status !== "blocked");
  }

  async function withAdminLoading(fn) {
    if (global.AdminLoading?.withLoading) {
      return global.AdminLoading.withLoading(fn, {
        key: "social-pack",
        delayMs: 0,
        message: "Creating your social graphics…",
        supportMessage: "Please wait while we prepare the destination campaign."
      });
    }
    return fn();
  }

  async function openForIssue(number, issueCruises) {
    issueNumber = Number(number);
    open = true;
    busy = true;
    preview = null;
    previewId = null;
    socialMediaId = null;
    treatment = "soft";
    imagePickerOpen = false;
    message = "Checking cruise readiness…";
    messageTone = "";
    cruises = (issueCruises || []).map((row) => ({
      id: row.id,
      headline: row.headline || "",
      destination: row.destination_strip || "",
      line: row.ci_cruise_lines?.name || "",
      ship: row.ci_cruise_ships?.name || "",
      departure: row.departure_date || "",
      returnDate: row.return_date || "",
      heroUrl: row.hero?.url || row.hero_image_url || "",
      selected: true,
      readiness: { status: "pending", label: "Checking…" }
    }));
    rerender();

    try {
      const headers = await authHeaders();
      const response = await fetch("/.netlify/functions/social-pack-generate", {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "readiness", newsletter_number: issueNumber })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) {
        throw new Error(data.error || "Could not load cruise readiness.");
      }
      const byId = new Map((data.cruises || []).map((c) => [c.id, c]));
      cruises = cruises.map((c) => {
        const remote = byId.get(c.id);
        if (!remote) return c;
        return {
          ...c,
          destination: remote.destination_strip || c.destination,
          line: remote.line_name || c.line,
          ship: remote.ship_name || c.ship,
          departure: remote.departure_date || c.departure,
          returnDate: remote.return_date || c.returnDate,
          heroUrl: remote.hero_url || c.heroUrl,
          readiness: remote.readiness || c.readiness,
          selected: remote.readiness?.status !== "blocked"
        };
      });
      const firstReady = cruises.find((c) => c.selected && c.readiness?.status !== "blocked");
      message = "";
      if (firstReady) {
        await previewCruise(firstReady.id);
      } else {
        message = "No cruises are ready to generate yet.";
        messageTone = "error";
        busy = false;
        rerender();
      }
    } catch (error) {
      busy = false;
      message = error.message || "Could not open Social Pack.";
      messageTone = "error";
      rerender();
    }
  }

  async function previewCruise(id) {
    if (busy && previewId === id && preview) return;
    previewId = id;
    busy = true;
    message = "";
    messageTone = "";
    imagePickerOpen = false;
    rerender();
    try {
      await withAdminLoading(async () => {
        const headers = await authHeaders();
        const response = await fetch("/.netlify/functions/social-pack-generate", {
          method: "POST",
          headers,
          body: JSON.stringify({
            action: "preview",
            featured_cruise_id: id,
            treatment,
            social_media_id: socialMediaId
          })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success === false) {
          throw new Error(data.error || "Preview failed.");
        }
        preview = data;
        message = "Preview ready.";
        messageTone = "success";
      });
    } catch (error) {
      preview = null;
      message = error.message || "Preview failed.";
      messageTone = "error";
    } finally {
      busy = false;
      rerender();
    }
  }

  async function regeneratePreview() {
    if (!previewId || busy) return;
    await previewCruise(previewId);
  }

  async function setTreatment(value) {
    treatment = String(value || "soft").toLowerCase();
    if (!["clear", "soft", "strong"].includes(treatment)) treatment = "soft";
    if (previewId) await regeneratePreview();
    else rerender();
  }

  function openImagePicker() {
    imagePickerOpen = true;
    imagePickerTab = "recommended";
    rerender();
  }

  function closeImagePicker() {
    imagePickerOpen = false;
    rerender();
  }

  function setImagePickerTab(tab) {
    imagePickerTab = tab;
    rerender();
  }

  async function useSocialImage(mediaId) {
    socialMediaId = mediaId || null;
    imagePickerOpen = false;
    if (previewId) await regeneratePreview();
    else rerender();
  }

  async function stepBackground(delta) {
    const list = preview?.background_candidates || [];
    if (!list.length || busy) return;
    const currentId = preview?.background?.media_id || socialMediaId;
    let idx = list.findIndex((m) => m.id === currentId);
    if (idx < 0) idx = 0;
    const next = list[(idx + delta + list.length) % list.length];
    if (next?.id) await useSocialImage(next.id);
  }

  async function downloadZip() {
    const ids = selectedIds();
    if (!ids.length || busy) return;
    busy = true;
    message = "Building Social Pack ZIP…";
    messageTone = "";
    rerender();
    try {
      await withAdminLoading(async () => {
        const headers = await authHeaders();
        const response = await fetch("/.netlify/functions/social-pack-generate", {
          method: "POST",
          headers,
          body: JSON.stringify({
            action: "download_issue",
            newsletter_number: issueNumber,
            featured_cruise_ids: ids,
            treatment
          })
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || "Download failed.");
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `newsletter-${issueNumber}-social-pack.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        message = "Social Pack ZIP downloaded.";
        messageTone = "success";
      });
    } catch (error) {
      message = error.message || "Download failed.";
      messageTone = "error";
    } finally {
      busy = false;
      rerender();
    }
  }

  function toggleCruise(id) {
    const row = cruises.find((c) => c.id === id);
    if (!row || row.readiness?.status === "blocked") return;
    row.selected = !row.selected;
    rerender();
  }

  function close() {
    open = false;
    preview = null;
    previewId = null;
    cruises = [];
    socialMediaId = null;
    imagePickerOpen = false;
    message = "";
    if (typeof global.renderAdmin === "function") global.renderAdmin();
  }

  function rerender() {
    if (typeof global.renderAdmin === "function") global.renderAdmin();
  }

  function stepPreview(delta) {
    const ready = selectedReady();
    if (!ready.length) return;
    socialMediaId = null;
    const idx = Math.max(0, ready.findIndex((c) => c.id === previewId));
    const next = ready[(idx + delta + ready.length) % ready.length];
    previewCruise(next.id);
  }

  function renderImagePicker() {
    if (!imagePickerOpen || !preview) return "";
    const sections = preview.picker_sections || {};
    const tabMap = {
      recommended: "Recommended",
      current_destination: "Current Destination",
      arrival: "Arrival",
      departure: "Departure",
      regional: "Regional",
      all: "All Destinations"
    };
    const rows = sections[imagePickerTab] || [];
    return `
      <div class="social-pack-image-picker">
        <div class="admin-list-top">
          <h4>Change Social Image</h4>
          <button type="button" class="admin-button secondary small" onclick="SocialPackAdmin.closeImagePicker()">Close</button>
        </div>
        <div class="media-picker-filters">
          ${Object.keys(tabMap)
            .map(
              (key) =>
                `<button type="button" class="media-filter-chip ${
                  imagePickerTab === key ? "is-active" : ""
                }" onclick="SocialPackAdmin.setImagePickerTab('${key}')">${tabMap[key]}</button>`
            )
            .join("")}
        </div>
        <div class="social-pack-image-grid">
          ${
            rows.length
              ? rows
                  .map(
                    (row) => `
            <article class="media-picker-card">
              <div class="media-picker-card-media"><img src="${esc(row.public_url)}" alt=""></div>
              <div class="media-picker-card-body">
                <h4 class="media-picker-card-title">${esc(row.title || "Untitled")}</h4>
                <p class="media-picker-card-meta">${esc(row.destination_name || "")}${
                      row.is_default ? " · Default" : ""
                    }</p>
                <button type="button" class="admin-button black small" onclick="SocialPackAdmin.useSocialImage('${esc(
                  row.id
                )}')" ${busy ? "disabled" : ""}>Use This Image</button>
              </div>
            </article>`
                  )
                  .join("")
              : `<p class="admin-muted">No images in this group.</p>`
          }
        </div>
      </div>`;
  }

  function renderSlides() {
    if (!preview?.slides) return "";
    const order = preview.slide_order || Object.keys(preview.slides);
    return `
      <div class="social-pack-slides">
        ${order
          .map((name, i) => {
            const src = preview.slides[name];
            if (!src) return "";
            return `<figure><img src="${esc(src)}" alt="${esc(name)}"><figcaption>${i + 1}. ${esc(
              name
            )}</figcaption></figure>`;
          })
          .join("")}
      </div>`;
  }

  function renderModal() {
    if (!open) return "";
    const selectedCount = cruises.filter((c) => c.selected).length;
    const msgClass =
      messageTone === "error" ? "admin-error" : messageTone === "success" ? "admin-success" : "";
    const bg = preview?.background;
    return `
      <div class="social-pack-overlay" role="dialog" aria-modal="true" aria-label="Create Social Pack">
        <div class="social-pack-modal admin-card">
          <div class="admin-list-top">
            <div>
              <p class="admin-nav-eyebrow">Marketing</p>
              <h3>Create Social Pack</h3>
              <p class="admin-muted">Newsletter ${esc(issueNumber)} · ${esc(selectedCount)} selected</p>
            </div>
            <button type="button" class="admin-button secondary" onclick="SocialPackAdmin.close()" ${busy ? "disabled" : ""}>Close</button>
          </div>
          ${message ? `<div class="admin-message ${msgClass}">${esc(message)}</div>` : ""}
          <div class="social-pack-layout">
            <div class="social-pack-list">
              ${cruises
                .map(
                  (c) => `
                <label class="social-pack-cruise ${c.id === previewId ? "is-active" : ""} ${c.readiness?.status === "blocked" ? "is-blocked" : ""}">
                  <input type="checkbox" ${c.selected ? "checked" : ""} ${
                    c.readiness?.status === "blocked" || busy ? "disabled" : ""
                  } onchange="SocialPackAdmin.toggleCruise('${esc(c.id)}')">
                  <span class="social-pack-thumb">${
                    c.heroUrl
                      ? `<img src="${esc(c.heroUrl)}" alt="" loading="lazy">`
                      : `<span class="admin-empty-preview">No image</span>`
                  }</span>
                  <span class="social-pack-cruise-copy">
                    <strong>${esc(c.destination || c.headline || "Cruise")}</strong>
                    <span class="admin-small">${esc([c.line, c.ship].filter(Boolean).join(" · "))}</span>
                    <span class="admin-small">${esc([c.departure, c.returnDate].filter(Boolean).join(" → "))}</span>
                    <span class="admin-small">${esc(c.readiness?.label || "")}</span>
                  </span>
                  <button type="button" class="admin-button secondary small" onclick="event.preventDefault();SocialPackAdmin.previewCruise('${esc(c.id)}')" ${
                    busy || c.readiness?.status === "blocked" ? "disabled" : ""
                  }>Preview</button>
                </label>`
                )
                .join("")}
            </div>
            <div class="social-pack-preview">
              ${
                preview?.slides
                  ? `
                    <div class="social-pack-controls">
                      <button type="button" class="admin-button secondary small" onclick="SocialPackAdmin.openImagePicker()" ${busy ? "disabled" : ""}>Change Social Image</button>
                      <div class="social-pack-treatment" role="group" aria-label="Background treatment">
                        <span class="admin-small">Background</span>
                        ${["clear", "soft", "strong"]
                          .map(
                            (t) =>
                              `<button type="button" class="media-filter-chip ${
                                treatment === t ? "is-active" : ""
                              }" onclick="SocialPackAdmin.setTreatment('${t}')" ${busy ? "disabled" : ""}>${
                                t.charAt(0).toUpperCase() + t.slice(1)
                              }</button>`
                          )
                          .join("")}
                      </div>
                      <button type="button" class="admin-button secondary small" onclick="SocialPackAdmin.stepBackground(-1)" ${busy ? "disabled" : ""}>Previous Image</button>
                      <button type="button" class="admin-button secondary small" onclick="SocialPackAdmin.stepBackground(1)" ${busy ? "disabled" : ""}>Next Image</button>
                      <button type="button" class="admin-button secondary small" onclick="SocialPackAdmin.regeneratePreview()" ${busy ? "disabled" : ""}>Regenerate Preview</button>
                    </div>
                    ${
                      bg
                        ? `<p class="admin-small">Image: ${esc(bg.title || bg.media_id || "—")} · ${esc(
                            bg.destination_key || ""
                          )} · ${esc(bg.match_role || "")} · rotation ${esc(
                            String(bg.rotation_index ?? "")
                          )}/${esc(String(bg.candidate_count ?? ""))}</p>`
                        : ""
                    }
                    ${renderImagePicker()}
                    ${renderSlides()}
                    <label class="admin-field"><span>Caption</span>
                      <textarea class="social-pack-caption" readonly rows="8">${esc(preview.caption || "")}</textarea>
                    </label>
                    <div class="admin-actions-row">
                      <button type="button" class="admin-button secondary" onclick="SocialPackAdmin.stepPreview(-1)" ${busy ? "disabled" : ""}>Previous cruise</button>
                      <button type="button" class="admin-button secondary" onclick="SocialPackAdmin.stepPreview(1)" ${busy ? "disabled" : ""}>Next cruise</button>
                    </div>`
                  : `<p class="admin-muted">${busy ? "Creating your social graphics…" : "Select a ready cruise to preview."}</p>`
              }
            </div>
          </div>
          <div class="admin-actions-row" style="margin-top:16px">
            <button type="button" class="admin-button black" onclick="SocialPackAdmin.downloadZip()" ${
              busy || !selectedIds().length ? "disabled" : ""
            }>${busy ? "Working…" : "Download Social Pack ZIP"}</button>
            <button type="button" class="admin-button secondary" onclick="SocialPackAdmin.close()" ${busy ? "disabled" : ""}>Close</button>
          </div>
        </div>
      </div>
    `;
  }

  global.SocialPackAdmin = {
    openForIssue,
    close,
    toggleCruise,
    previewCruise,
    downloadZip,
    stepPreview,
    setTreatment,
    openImagePicker,
    closeImagePicker,
    setImagePickerTab,
    useSocialImage,
    stepBackground,
    regeneratePreview,
    renderModal,
    isOpen: () => open
  };
})(typeof window !== "undefined" ? window : globalThis);
