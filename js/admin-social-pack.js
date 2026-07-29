/**
 * Newsletter Issue Composer — Create Social Pack modal (approved three-card pack).
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
  /** @type {Record<string, string[]>} room_label lists keyed by cruise id */
  let roomSelections = {};

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

  function cruiseRooms(cruise) {
    return Array.isArray(cruise?.offers) ? cruise.offers : [];
  }

  function ensureRoomDefaults(cruise) {
    if (!cruise?.id) return;
    if (roomSelections[cruise.id] != null) return;
    roomSelections[cruise.id] = cruiseRooms(cruise).map((o) => o.room_label).filter(Boolean);
  }

  function includedRoomsFor(cruiseId) {
    if (roomSelections[cruiseId] != null) return roomSelections[cruiseId];
    const cruise = cruises.find((c) => c.id === cruiseId);
    return cruiseRooms(cruise).map((o) => o.room_label).filter(Boolean);
  }

  function buildCruiseOptions(ids) {
    const options = {};
    for (const id of ids) {
      options[id] = {
        included_room_labels: includedRoomsFor(id)
      };
      if (id === previewId && socialMediaId) {
        options[id].social_media_id = socialMediaId;
      }
    }
    return options;
  }

  async function withAdminLoading(fn, { forZip = false } = {}) {
    if (global.AdminLoading?.withLoading) {
      return global.AdminLoading.withLoading(fn, {
        key: "social-pack",
        delayMs: 0,
        message: forZip ? "Preparing your social pack…" : "Creating your social graphics…",
        supportMessage: forZip
          ? "Please wait while we create the newsletter graphics and captions."
          : "Please wait while we prepare the destination campaign."
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
    roomSelections = {};
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
      offers: [],
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
        const next = {
          ...c,
          destination: remote.destination_strip || c.destination,
          line: remote.line_name || c.line,
          ship: remote.ship_name || c.ship,
          departure: remote.departure_date || c.departure,
          returnDate: remote.return_date || c.returnDate,
          heroUrl: remote.hero_url || c.heroUrl,
          readiness: remote.readiness || c.readiness,
          offers: remote.offers || [],
          selected: remote.readiness?.status !== "blocked"
        };
        ensureRoomDefaults(next);
        return next;
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
    const cruise = cruises.find((c) => c.id === id);
    if (cruise) ensureRoomDefaults(cruise);
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
            social_media_id: socialMediaId,
            included_room_labels: includedRoomsFor(id)
          })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success === false) {
          const ref = data.correlation_id ? ` Ref ${data.correlation_id.slice(0, 8)}.` : "";
          throw new Error(
            (data.error || "We couldn’t create the preview. Please try again.") + ref
          );
        }
        preview = data;
        if (cruise && Array.isArray(data.available_offers)) {
          cruise.offers = data.available_offers;
          ensureRoomDefaults(cruise);
        }
        const warnings = data.warnings || [];
        if (warnings.includes("no_public_price") || !(data.offers || []).length) {
          message = "No public room prices are available for this cruise.";
          messageTone = "error";
        } else {
          message = "Preview ready. Downloads use full 1080×1350 resolution.";
          messageTone = "success";
        }
      });
    } catch (error) {
      preview = null;
      message = error.message || "We couldn’t create the preview. Please try again.";
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

  function toggleRoom(cruiseId, roomLabel) {
    const cruise = cruises.find((c) => c.id === cruiseId);
    if (!cruise || busy) return;
    ensureRoomDefaults(cruise);
    const current = new Set(roomSelections[cruiseId] || []);
    if (current.has(roomLabel)) current.delete(roomLabel);
    else current.add(roomLabel);
    roomSelections[cruiseId] = Array.from(current);
    // Preserve display_order from available offers
    const order = cruiseRooms(cruise).map((o) => o.room_label);
    roomSelections[cruiseId] = order.filter((label) => current.has(label));
    rerender();
  }

  async function applyRoomSelectionAndPreview(cruiseId, roomLabel) {
    toggleRoom(cruiseId, roomLabel);
    if (previewId === cruiseId) await regeneratePreview();
  }

  async function downloadZip() {
    const ids = selectedIds();
    if (!ids.length || busy) return;
    busy = true;
    message = "Preparing your social pack…";
    messageTone = "";
    rerender();
    try {
      await withAdminLoading(
        async () => {
          const headers = await authHeaders();
          const response = await fetch("/.netlify/functions/social-pack-generate", {
            method: "POST",
            headers,
            body: JSON.stringify({
              action: "download_issue",
              newsletter_number: issueNumber,
              featured_cruise_ids: ids,
              treatment,
              cruise_options: buildCruiseOptions(ids)
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
        },
        { forZip: true }
      );
    } catch (error) {
      message = error.message || "Download failed.";
      messageTone = "error";
    } finally {
      busy = false;
      rerender();
    }
  }

  async function downloadThisCruise() {
    if (!previewId || busy) return;
    busy = true;
    message = "Preparing your social pack…";
    messageTone = "";
    rerender();
    try {
      await withAdminLoading(
        async () => {
          const headers = await authHeaders();
          const response = await fetch("/.netlify/functions/social-pack-generate", {
            method: "POST",
            headers,
            body: JSON.stringify({
              action: "download_cruise",
              newsletter_number: issueNumber,
              featured_cruise_id: previewId,
              treatment,
              social_media_id: socialMediaId,
              included_room_labels: includedRoomsFor(previewId)
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
          a.download = `newsletter-${issueNumber}-cruise-social-pack.zip`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
          message = "Cruise Social Pack downloaded.";
          messageTone = "success";
        },
        { forZip: true }
      );
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
    roomSelections = {};
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

  function copyCaption() {
    const text = preview?.caption || "";
    if (!text) return;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => {
          message = "Caption copied.";
          messageTone = "success";
          rerender();
        },
        () => {
          message = "Could not copy caption.";
          messageTone = "error";
          rerender();
        }
      );
    }
  }

  function renderRoomChecks(cruise) {
    const rooms = cruiseRooms(cruise);
    if (!rooms.length) {
      return `<p class="admin-small admin-error">No public room prices are available for this cruise.</p>`;
    }
    const selected = new Set(includedRoomsFor(cruise.id));
    return `
      <div class="social-pack-rooms" role="group" aria-label="Room prices">
        <p class="admin-small"><strong>Room prices</strong></p>
        ${rooms
          .map((room) => {
            const label = room.room_label;
            const display = room.room_label_display || label;
            const price = room.price_label || "";
            const checked = selected.has(label) ? "checked" : "";
            return `
              <label class="social-pack-room">
                <input type="checkbox" ${checked} ${busy ? "disabled" : ""}
                  onchange="SocialPackAdmin.toggleRoom('${esc(cruise.id)}', '${esc(label)}')">
                <span>${esc(display)}${price ? ` · ${esc(price)}` : ""}</span>
              </label>`;
          })
          .join("")}
      </div>`;
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
    const activeCruise = cruises.find((c) => c.id === previewId);
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
                <div class="social-pack-cruise ${c.id === previewId ? "is-active" : ""} ${c.readiness?.status === "blocked" ? "is-blocked" : ""}">
                  <label class="social-pack-cruise-main">
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
                  </label>
                  <button type="button" class="admin-button secondary small" onclick="SocialPackAdmin.previewCruise('${esc(c.id)}')" ${
                    busy || c.readiness?.status === "blocked" ? "disabled" : ""
                  }>Preview</button>
                  ${c.id === previewId ? renderRoomChecks(c) : ""}
                </div>`
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
                    <p class="admin-small">Preview is reduced resolution for Admin. Downloads remain full 1080×1350.</p>
                    ${
                      activeCruise && !(activeCruise.offers || []).length
                        ? `<div class="admin-message admin-error">No public room prices are available for this cruise.</div>`
                        : ""
                    }
                    ${renderImagePicker()}
                    ${renderSlides()}
                    <label class="admin-field"><span>Caption</span>
                      <textarea class="social-pack-caption" readonly rows="10">${esc(preview.caption || "")}</textarea>
                    </label>
                    <div class="admin-actions-row">
                      <button type="button" class="admin-button secondary small" onclick="SocialPackAdmin.copyCaption()" ${busy ? "disabled" : ""}>Copy caption</button>
                      <button type="button" class="admin-button secondary" onclick="SocialPackAdmin.stepPreview(-1)" ${busy ? "disabled" : ""}>Previous cruise</button>
                      <button type="button" class="admin-button secondary" onclick="SocialPackAdmin.stepPreview(1)" ${busy ? "disabled" : ""}>Next cruise</button>
                    </div>`
                  : `<p class="admin-muted">${busy ? "Creating your social graphics…" : "Select a ready cruise to preview."}</p>`
              }
            </div>
          </div>
          <div class="admin-actions-row" style="margin-top:16px">
            <button type="button" class="admin-button secondary" onclick="SocialPackAdmin.downloadThisCruise()" ${
              busy || !previewId ? "disabled" : ""
            }>Download This Cruise</button>
            <button type="button" class="admin-button black" onclick="SocialPackAdmin.downloadZip()" ${
              busy || !selectedIds().length ? "disabled" : ""
            }>${busy ? "Working…" : "Download Newsletter Social Pack"}</button>
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
    toggleRoom: applyRoomSelectionAndPreview,
    previewCruise,
    downloadZip,
    downloadThisCruise,
    stepPreview,
    setTreatment,
    openImagePicker,
    closeImagePicker,
    setImagePickerTab,
    useSocialImage,
    stepBackground,
    regeneratePreview,
    copyCaption,
    renderModal,
    isOpen: () => open
  };
})(typeof window !== "undefined" ? window : globalThis);
