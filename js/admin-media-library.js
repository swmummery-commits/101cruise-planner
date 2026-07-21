/**
 * Admin Media Library tab + reusable visual Media Picker.
 * Depends on: esc, supabaseClient, adminAuthHeaders, ciCruiseLines, ciCruiseShips,
 * resizeCiImageFile (optional), renderAdmin, activeTab.
 */
(function (global) {
  "use strict";

  let mediaItems = [];
  let mediaLoading = false;
  let mediaMessage = "";
  let mediaMessageTone = "";
  let mediaSearchQuery = "";
  let mediaTypeFilter = "all";
  let mediaActiveFilter = "active";
  let editingMediaId = null;
  let showMediaUpload = false;
  let mediaSaving = false;

  let pickerOpen = false;
  let pickerOptions = null;
  let pickerSelectedId = null;
  let pickerFilter = "recommended";
  let pickerSearch = "";
  let pickerUploadMode = false;

  let uploadDraft = {
    file: null,
    localPreview: "",
    title: "",
    alt_text: "",
    media_type: "general",
    cruise_line_id: "",
    ship_id: "",
    destination_name: "",
    port_name: "",
    tags: "",
    is_default: false,
    width: null,
    height: null
  };

  function esc(value) {
    return typeof global.esc === "function"
      ? global.esc(value)
      : String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");
  }

  async function mediaApi(action, payload = {}) {
    const headers =
      typeof global.adminAuthHeaders === "function"
        ? await global.adminAuthHeaders()
        : { "Content-Type": "application/json" };
    const response = await fetch("/.netlify/functions/media-library", {
      method: "POST",
      headers,
      body: JSON.stringify({ action, ...payload })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      throw new Error(data.error || `Media library request failed (${response.status})`);
    }
    return data;
  }

  async function loadMediaLibrary({ quiet = false } = {}) {
    mediaLoading = true;
    if (!quiet) {
      mediaMessage = "";
      mediaMessageTone = "";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    }
    try {
      const result = await mediaApi("list", { limit: 400 });
      mediaItems = result.media || [];
    } catch (error) {
      mediaMessage = error.message || "Could not load media library.";
      mediaMessageTone = "error";
      mediaItems = [];
    } finally {
      mediaLoading = false;
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    }
  }

  function filteredMediaItems() {
    const q = mediaSearchQuery.trim().toLowerCase();
    return mediaItems.filter((row) => {
      if (mediaTypeFilter !== "all" && row.media_type !== mediaTypeFilter) return false;
      if (mediaActiveFilter === "active" && row.is_active === false) return false;
      if (mediaActiveFilter === "inactive" && row.is_active !== false) return false;
      if (!q) return true;
      const hay = [
        row.title,
        row.alt_text,
        row.file_name,
        row.destination_name,
        row.port_name,
        row.media_type,
        ...(row.tags || []),
        row.ci_cruise_lines?.name,
        row.ci_cruise_ships?.name
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }

  function mediaTypeLabel(type) {
    const map = {
      ship: "Ship",
      destination: "Destination",
      port: "Port",
      route_map: "Route Map",
      general: "General"
    };
    return map[type] || type || "General";
  }

  function associationLabel(row) {
    if (row.ci_cruise_ships?.name) return row.ci_cruise_ships.name;
    if (row.destination_name) return row.destination_name;
    if (row.port_name) return row.port_name;
    if (row.ci_cruise_lines?.name) return row.ci_cruise_lines.name;
    return "";
  }

  function resetUploadDraft(overrides = {}) {
    if (uploadDraft.localPreview) URL.revokeObjectURL(uploadDraft.localPreview);
    uploadDraft = {
      file: null,
      localPreview: "",
      title: "",
      alt_text: "",
      media_type: "general",
      cruise_line_id: "",
      ship_id: "",
      destination_name: "",
      port_name: "",
      tags: "",
      is_default: false,
      width: null,
      height: null,
      ...overrides
    };
  }

  async function prepareUploadFile(file) {
    const allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    if (!allowed.includes(file.type)) {
      throw new Error("Unsupported file type. Use JPG, PNG or WebP.");
    }
    if (file.size > 10 * 1024 * 1024) {
      throw new Error("File too large. Maximum is 10 MB.");
    }
    let prepared = file;
    if (typeof global.resizeCiImageFile === "function") {
      prepared = await global.resizeCiImageFile(file, 2000, 0.85);
    }
    if (prepared.size > 10 * 1024 * 1024) {
      throw new Error("File still too large after optimisation (max 10 MB).");
    }
    let width = null;
    let height = null;
    try {
      const bitmap = await createImageBitmap(prepared);
      width = bitmap.width;
      height = bitmap.height;
      bitmap.close?.();
    } catch (_error) {
      /* ignore */
    }
    return { file: prepared, width, height };
  }

  async function onMediaFileChosen(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;
    try {
      const prepared = await prepareUploadFile(file);
      if (uploadDraft.localPreview) URL.revokeObjectURL(uploadDraft.localPreview);
      uploadDraft.file = prepared.file;
      uploadDraft.localPreview = URL.createObjectURL(prepared.file);
      uploadDraft.width = prepared.width;
      uploadDraft.height = prepared.height;
      if (!uploadDraft.title) {
        uploadDraft.title = String(file.name || "Image").replace(/\.[^.]+$/, "");
      }
      mediaMessage = "";
      mediaMessageTone = "";
    } catch (error) {
      mediaMessage = error.message || "Could not prepare image.";
      mediaMessageTone = "error";
    }
    event.target.value = "";
    if (typeof global.renderAdmin === "function") global.renderAdmin();
  }

  function captureUploadDraftFromDom() {
    uploadDraft.title = document.getElementById("mediaUploadTitle")?.value || uploadDraft.title;
    uploadDraft.alt_text = document.getElementById("mediaUploadAlt")?.value || "";
    uploadDraft.media_type = document.getElementById("mediaUploadType")?.value || "general";
    uploadDraft.cruise_line_id = document.getElementById("mediaUploadLine")?.value || "";
    uploadDraft.ship_id = document.getElementById("mediaUploadShip")?.value || "";
    uploadDraft.destination_name = document.getElementById("mediaUploadDestination")?.value || "";
    uploadDraft.port_name = document.getElementById("mediaUploadPort")?.value || "";
    uploadDraft.tags = document.getElementById("mediaUploadTags")?.value || "";
    uploadDraft.is_default = Boolean(document.getElementById("mediaUploadDefault")?.checked);
  }

  async function submitMediaUpload({ selectForPicker = false, onSelected = null } = {}) {
    captureUploadDraftFromDom();
    if (!uploadDraft.file) {
      mediaMessage = "Choose an image file first.";
      mediaMessageTone = "error";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
      return null;
    }
    if (!String(uploadDraft.title || "").trim()) {
      mediaMessage = "Title is required.";
      mediaMessageTone = "error";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
      return null;
    }

    mediaSaving = true;
    mediaMessage = "Uploading…";
    mediaMessageTone = "";
    if (typeof global.renderAdmin === "function") global.renderAdmin();

    try {
      const prepared = await mediaApi("create_upload", {
        filename: uploadDraft.file.name,
        mime_type: uploadDraft.file.type,
        size_bytes: uploadDraft.file.size,
        media_type: uploadDraft.media_type,
        ship_id: uploadDraft.ship_id || null,
        destination_name: uploadDraft.destination_name || null,
        port_name: uploadDraft.port_name || null,
        featured_cruise_id: pickerOptions?.featuredCruiseId || null,
        public_slug: pickerOptions?.publicSlug || null
      });

      const client =
        typeof global.getAdminSupabaseClient === "function"
          ? global.getAdminSupabaseClient()
          : global.supabaseClient;
      if (!client?.storage) throw new Error("Supabase client is not available.");
      const { error: uploadError } = await client.storage
        .from(prepared.bucket)
        .uploadToSignedUrl(prepared.storage_path, prepared.token, uploadDraft.file, {
          contentType: uploadDraft.file.type
        });
      if (uploadError) throw uploadError;

      const created = await mediaApi("create_record", {
        title: uploadDraft.title,
        alt_text: uploadDraft.alt_text,
        media_type: uploadDraft.media_type,
        storage_path: prepared.storage_path,
        public_url: prepared.public_url,
        file_name: uploadDraft.file.name,
        mime_type: uploadDraft.file.type,
        width: uploadDraft.width,
        height: uploadDraft.height,
        file_size_bytes: uploadDraft.file.size,
        cruise_line_id: uploadDraft.cruise_line_id || null,
        ship_id: uploadDraft.ship_id || null,
        destination_name: uploadDraft.destination_name || null,
        port_name: uploadDraft.port_name || null,
        tags: uploadDraft.tags,
        is_default: uploadDraft.is_default
      });

      await loadMediaLibrary({ quiet: true });
      showMediaUpload = false;
      pickerUploadMode = false;
      resetUploadDraft();
      mediaMessage = "Image uploaded to Media Library.";
      mediaMessageTone = "success";

      if (selectForPicker && created.media) {
        pickerSelectedId = created.media.id;
      }
      if (typeof onSelected === "function" && created.media) {
        onSelected(created.media);
      }
      if (typeof global.renderAdmin === "function") global.renderAdmin();
      return created.media;
    } catch (error) {
      mediaMessage = error.message || "Upload failed.";
      mediaMessageTone = "error";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
      return null;
    } finally {
      mediaSaving = false;
    }
  }

  function openMediaEditor(id) {
    editingMediaId = id;
    showMediaUpload = false;
    if (typeof global.renderAdmin === "function") global.renderAdmin();
  }

  function onMediaCardKeydown(event, id) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openMediaEditor(id);
    }
  }

  function captureMediaEditorFromDom(row) {
    return {
      id: row.id,
      title: document.getElementById("mediaEditTitle")?.value || "",
      alt_text: document.getElementById("mediaEditAlt")?.value || "",
      media_type: document.getElementById("mediaEditType")?.value || row.media_type,
      cruise_line_id: document.getElementById("mediaEditLine")?.value || null,
      ship_id: document.getElementById("mediaEditShip")?.value || null,
      destination_name: document.getElementById("mediaEditDestination")?.value || "",
      port_name: document.getElementById("mediaEditPort")?.value || "",
      tags: document.getElementById("mediaEditTags")?.value || "",
      is_default: Boolean(document.getElementById("mediaEditDefault")?.checked),
      is_active: Boolean(document.getElementById("mediaEditActive")?.checked)
    };
  }

  async function saveMediaEditor() {
    const row = mediaItems.find((m) => m.id === editingMediaId);
    if (!row) return;
    mediaSaving = true;
    mediaMessage = "Saving…";
    mediaMessageTone = "";
    if (typeof global.renderAdmin === "function") global.renderAdmin();
    try {
      const payload = captureMediaEditorFromDom(row);
      await mediaApi("update_record", payload);
      await loadMediaLibrary({ quiet: true });
      mediaMessage = "Media saved.";
      mediaMessageTone = "success";
      editingMediaId = null;
    } catch (error) {
      mediaMessage = error.message || "Could not save media.";
      mediaMessageTone = "error";
    } finally {
      mediaSaving = false;
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    }
  }

  async function deleteMediaEditor() {
    const row = mediaItems.find((m) => m.id === editingMediaId);
    if (!row) return;
    if (!window.confirm(`Delete “${row.title}”? This cannot be undone.`)) return;
    mediaSaving = true;
    mediaMessage = "Deleting…";
    mediaMessageTone = "";
    if (typeof global.renderAdmin === "function") global.renderAdmin();
    try {
      await mediaApi("delete_record", { id: row.id });
      await loadMediaLibrary({ quiet: true });
      editingMediaId = null;
      mediaMessage = "Media deleted.";
      mediaMessageTone = "success";
    } catch (error) {
      mediaMessage = error.message || "Could not delete media.";
      mediaMessageTone = "error";
    } finally {
      mediaSaving = false;
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    }
  }

  async function replaceMediaImage(event) {
    const row = mediaItems.find((m) => m.id === editingMediaId);
    const file = event?.target?.files?.[0];
    if (!row || !file) return;
    mediaSaving = true;
    mediaMessage = "Replacing image…";
    mediaMessageTone = "";
    if (typeof global.renderAdmin === "function") global.renderAdmin();
    try {
      const preparedFile = await prepareUploadFile(file);
      const prepared = await mediaApi("create_upload", {
        filename: preparedFile.file.name,
        mime_type: preparedFile.file.type,
        size_bytes: preparedFile.file.size,
        media_type: row.media_type,
        ship_id: row.ship_id || null,
        destination_name: row.destination_name || null,
        port_name: row.port_name || null
      });
      const client =
        typeof global.getAdminSupabaseClient === "function"
          ? global.getAdminSupabaseClient()
          : global.supabaseClient;
      if (!client?.storage) throw new Error("Supabase client is not available.");
      const { error: uploadError } = await client.storage
        .from(prepared.bucket)
        .uploadToSignedUrl(prepared.storage_path, prepared.token, preparedFile.file, {
          contentType: preparedFile.file.type
        });
      if (uploadError) throw uploadError;

      await mediaApi("update_record", {
        id: row.id,
        storage_path: prepared.storage_path,
        public_url: prepared.public_url,
        file_name: preparedFile.file.name,
        mime_type: preparedFile.file.type,
        width: preparedFile.width,
        height: preparedFile.height,
        file_size_bytes: preparedFile.file.size
      });
      await loadMediaLibrary({ quiet: true });
      mediaMessage = "Image file replaced. Metadata preserved.";
      mediaMessageTone = "success";
    } catch (error) {
      mediaMessage = error.message || "Could not replace image.";
      mediaMessageTone = "error";
    } finally {
      mediaSaving = false;
      if (event?.target) event.target.value = "";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    }
  }

  async function setMediaAsDefault() {
    const row = mediaItems.find((m) => m.id === editingMediaId);
    if (!row) return;
    mediaSaving = true;
    try {
      await mediaApi("update_record", {
        id: row.id,
        is_default: true,
        media_type: row.media_type,
        ship_id: row.ship_id,
        destination_name: row.destination_name
      });
      await loadMediaLibrary({ quiet: true });
      mediaMessage = "Marked as default.";
      mediaMessageTone = "success";
    } catch (error) {
      mediaMessage = error.message || "Could not set default.";
      mediaMessageTone = "error";
    } finally {
      mediaSaving = false;
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    }
  }

  function ciLines() {
    if (typeof global.getAdminCiCruiseLines === "function") return global.getAdminCiCruiseLines() || [];
    return global.ciCruiseLines || [];
  }

  function ciShips() {
    if (typeof global.getAdminCiCruiseShips === "function") return global.getAdminCiCruiseShips() || [];
    return global.ciCruiseShips || [];
  }

  function lineOptionsHtml(selected) {
    const lines = ciLines();
    return [
      `<option value="">None</option>`,
      ...lines
        .filter((l) => l.active !== false)
        .map(
          (l) =>
            `<option value="${esc(l.id)}" ${l.id === selected ? "selected" : ""}>${esc(l.name)}</option>`
        )
    ].join("");
  }

  function shipOptionsHtml(lineId, selected) {
    const ships = ciShips().filter(
      (s) => (!lineId || s.cruise_line_id === lineId) && s.active !== false
    );
    return [
      `<option value="">None</option>`,
      ...ships.map(
        (s) =>
          `<option value="${esc(s.id)}" ${s.id === selected ? "selected" : ""}>${esc(s.name)}</option>`
      )
    ].join("");
  }

  function renderUploadForm({ compact = false } = {}) {
    return `
      <div class="media-upload-form ${compact ? "is-compact" : ""}">
        <div class="admin-field">
          <label>Image file</label>
          <input type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" onchange="MediaLibraryAdmin.onMediaFileChosen(event)">
          <div class="admin-helper">JPG, PNG or WebP. Max 10 MB. Large images are resized to ~2000px.</div>
        </div>
        ${
          uploadDraft.localPreview
            ? `<div class="media-upload-preview"><img src="${esc(uploadDraft.localPreview)}" alt="Upload preview"></div>`
            : `<div class="media-upload-preview is-empty">No file selected</div>`
        }
        <div class="featured-form-grid">
          <div class="admin-field"><label>Title *</label><input id="mediaUploadTitle" type="text" value="${esc(uploadDraft.title)}"></div>
          <div class="admin-field"><label>Alt text</label><input id="mediaUploadAlt" type="text" value="${esc(uploadDraft.alt_text)}"></div>
          <div class="admin-field">
            <label>Media type</label>
            <select id="mediaUploadType">
              ${["ship", "destination", "port", "route_map", "general"]
                .map(
                  (t) =>
                    `<option value="${t}" ${uploadDraft.media_type === t ? "selected" : ""}>${esc(mediaTypeLabel(t))}</option>`
                )
                .join("")}
            </select>
          </div>
          <div class="admin-field"><label>Cruise line</label><select id="mediaUploadLine" onchange="MediaLibraryAdmin.onUploadLineChange()">${lineOptionsHtml(uploadDraft.cruise_line_id)}</select></div>
          <div class="admin-field"><label>Ship</label><select id="mediaUploadShip">${shipOptionsHtml(uploadDraft.cruise_line_id, uploadDraft.ship_id)}</select></div>
          <div class="admin-field"><label>Destination</label><input id="mediaUploadDestination" type="text" value="${esc(uploadDraft.destination_name)}" placeholder="e.g. Santorini"></div>
          <div class="admin-field"><label>Port</label><input id="mediaUploadPort" type="text" value="${esc(uploadDraft.port_name)}"></div>
          <div class="admin-field"><label>Tags</label><input id="mediaUploadTags" type="text" value="${esc(uploadDraft.tags)}" placeholder="sunset, caldera"></div>
        </div>
        <label class="featured-inc"><input id="mediaUploadDefault" type="checkbox" ${uploadDraft.is_default ? "checked" : ""}> Set as default for this ship/destination</label>
      </div>
    `;
  }

  function renderMediaEditor() {
    const row = mediaItems.find((m) => m.id === editingMediaId);
    if (!row) return `<p class="admin-muted">Media not found.</p>`;
    const msgClass =
      mediaMessageTone === "error"
        ? "admin-error"
        : mediaMessageTone === "success"
          ? "admin-success"
          : mediaSaving || /^(Uploading|Saving)/i.test(String(mediaMessage || ""))
            ? "admin-running"
            : "";
    return `
      <div class="admin-card">
        <div class="admin-list-top">
          <div>
            <h3>${esc(row.title)}</h3>
            <p class="admin-muted">Media Library details</p>
          </div>
          <div class="admin-actions-row">
            <button class="admin-button secondary" onclick="MediaLibraryAdmin.closeEditor()" ${mediaSaving ? "disabled" : ""}>Cancel</button>
            <button class="admin-button secondary" onclick="MediaLibraryAdmin.setMediaAsDefault()" ${mediaSaving ? "disabled" : ""}>Set as Default</button>
            <label class="admin-button secondary" style="cursor:pointer;display:inline-flex;align-items:center">
              Replace Image
              <input type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" hidden onchange="MediaLibraryAdmin.replaceMediaImage(event)" ${mediaSaving ? "disabled" : ""}>
            </label>
            <button class="admin-button secondary" onclick="MediaLibraryAdmin.deleteMediaEditor()" ${mediaSaving ? "disabled" : ""}>Delete</button>
            <button class="admin-button black" onclick="MediaLibraryAdmin.saveMediaEditor()" ${mediaSaving ? "disabled" : ""}>${mediaSaving ? "Saving…" : "Save"}</button>
            ${
              mediaSaving || /^(Uploading|Saving)/i.test(String(mediaMessage || ""))
                ? `<span class="admin-running-status" role="status" aria-live="polite">${esc(mediaMessage)}</span>`
                : ""
            }
          </div>
        </div>
        ${
          mediaMessage && !(mediaSaving || /^(Uploading|Saving)/i.test(String(mediaMessage || "")))
            ? `<div class="admin-message ${msgClass}">${esc(mediaMessage)}</div>`
            : ""
        }
        <div class="media-editor-layout">
          <div class="media-editor-preview"><img src="${esc(row.public_url)}" alt="${esc(row.alt_text || row.title)}"></div>
          <div>
            <div class="featured-form-grid">
              <div class="admin-field"><label>Title</label><input id="mediaEditTitle" type="text" value="${esc(row.title)}"></div>
              <div class="admin-field"><label>Alt text</label><input id="mediaEditAlt" type="text" value="${esc(row.alt_text || "")}"></div>
              <div class="admin-field">
                <label>Media type</label>
                <select id="mediaEditType">
                  ${["ship", "destination", "port", "route_map", "general"]
                    .map(
                      (t) =>
                        `<option value="${t}" ${row.media_type === t ? "selected" : ""}>${esc(mediaTypeLabel(t))}</option>`
                    )
                    .join("")}
                </select>
              </div>
              <div class="admin-field"><label>Cruise line</label><select id="mediaEditLine">${lineOptionsHtml(row.cruise_line_id || "")}</select></div>
              <div class="admin-field"><label>Ship</label><select id="mediaEditShip">${shipOptionsHtml(row.cruise_line_id || "", row.ship_id || "")}</select></div>
              <div class="admin-field"><label>Destination</label><input id="mediaEditDestination" type="text" value="${esc(row.destination_name || "")}"></div>
              <div class="admin-field"><label>Port</label><input id="mediaEditPort" type="text" value="${esc(row.port_name || "")}"></div>
              <div class="admin-field"><label>Tags</label><input id="mediaEditTags" type="text" value="${esc((row.tags || []).join(", "))}"></div>
            </div>
            <div class="media-editor-flags">
              <label class="featured-inc"><input id="mediaEditDefault" type="checkbox" ${row.is_default ? "checked" : ""}> Default image</label>
              <label class="featured-inc"><input id="mediaEditActive" type="checkbox" ${row.is_active !== false ? "checked" : ""}> Active</label>
            </div>
            <p class="admin-small">${esc(row.width || "—")}×${esc(row.height || "—")} · ${esc(row.mime_type || "—")} · ${row.file_size_bytes != null ? `${Math.round(row.file_size_bytes / 1024)} KB` : "—"} · ${esc(row.storage_path || "")}</p>
          </div>
        </div>
      </div>
    `;
  }

  function renderMediaCard(row) {
    const assoc = associationLabel(row);
    return `
      <article
        class="media-library-card admin-object-card"
        role="button"
        tabindex="0"
        aria-label="Open ${esc(row.title)}"
        onclick="MediaLibraryAdmin.openMediaEditor('${esc(row.id)}')"
        onkeydown="MediaLibraryAdmin.onMediaCardKeydown(event, '${esc(row.id)}')"
      >
        <div class="media-library-thumb">
          <img src="${esc(row.public_url)}" alt="" loading="lazy">
        </div>
        <div class="media-library-card-body">
          <h4>${esc(row.title)}</h4>
          <p class="admin-small">${esc(mediaTypeLabel(row.media_type))}${assoc ? ` · ${esc(assoc)}` : ""}</p>
          <div class="media-library-badges">
            ${row.is_default ? `<span class="media-badge">Default</span>` : ""}
            ${row.is_active === false ? `<span class="media-badge is-inactive">Inactive</span>` : ""}
          </div>
        </div>
      </article>
    `;
  }

  function renderMediaLibraryPanel() {
    if (editingMediaId) return renderMediaEditor();

    if (showMediaUpload) {
      const isRunning = mediaSaving || /^(Uploading|Saving)/i.test(String(mediaMessage || ""));
      const msgClass =
        mediaMessageTone === "error"
          ? "admin-error"
          : mediaMessageTone === "success"
            ? "admin-success"
            : isRunning
              ? "admin-running"
              : "";
      const inlineRunning =
        isRunning && mediaMessage
          ? `<span class="admin-running-status" role="status" aria-live="polite">${esc(mediaMessage)}</span>`
          : "";
      return `
        <div class="admin-card">
          <div class="admin-list-top">
            <div>
              <h3>Upload New Image</h3>
              <p class="admin-muted">Stored once in Supabase and reusable across newsletters and cruise pages.</p>
            </div>
            <div class="admin-actions-row">
              <button class="admin-button secondary" onclick="MediaLibraryAdmin.cancelUpload()" ${mediaSaving ? "disabled" : ""}>Cancel</button>
              <button class="admin-button black" onclick="MediaLibraryAdmin.submitMediaUpload()" ${mediaSaving ? "disabled" : ""}>${mediaSaving ? "Uploading…" : "Upload"}</button>
              ${inlineRunning}
            </div>
          </div>
          ${!isRunning && mediaMessage ? `<div class="admin-message ${msgClass}">${esc(mediaMessage)}</div>` : ""}
          ${renderUploadForm()}
          <div class="admin-actions-row" style="justify-content:flex-end;margin-top:18px">
            <button class="admin-button secondary" onclick="MediaLibraryAdmin.cancelUpload()" ${mediaSaving ? "disabled" : ""}>Cancel</button>
            <button class="admin-button black" onclick="MediaLibraryAdmin.submitMediaUpload()" ${mediaSaving ? "disabled" : ""}>${mediaSaving ? "Uploading…" : "Upload"}</button>
            ${inlineRunning}
          </div>
        </div>
      `;
    }

    const rows = filteredMediaItems();
    const msgClass =
      mediaMessageTone === "error"
        ? "admin-error"
        : mediaMessageTone === "success"
          ? "admin-success"
          : mediaSaving || /^(Uploading|Saving)/i.test(String(mediaMessage || ""))
            ? "admin-running"
            : "";
    return `
      <div class="admin-card">
        <div class="admin-list-top">
          <div>
            <h3>Media Library</h3>
            <p class="admin-muted">Upload once, reuse across newsletters and public cruise pages.</p>
          </div>
          <button class="admin-button black" onclick="MediaLibraryAdmin.startUpload()">+ Upload</button>
        </div>
        <div class="featured-cruises-toolbar">
          <div class="admin-field">
            <label>Search</label>
            <input type="search" value="${esc(mediaSearchQuery)}" placeholder="Title, ship, destination, tags…" oninput="MediaLibraryAdmin.setSearch(this.value)">
          </div>
          <div class="admin-field">
            <label>Type</label>
            <select onchange="MediaLibraryAdmin.setTypeFilter(this.value)">
              <option value="all" ${mediaTypeFilter === "all" ? "selected" : ""}>All</option>
              <option value="ship" ${mediaTypeFilter === "ship" ? "selected" : ""}>Ships</option>
              <option value="destination" ${mediaTypeFilter === "destination" ? "selected" : ""}>Destinations</option>
              <option value="port" ${mediaTypeFilter === "port" ? "selected" : ""}>Ports</option>
              <option value="route_map" ${mediaTypeFilter === "route_map" ? "selected" : ""}>Route Maps</option>
              <option value="general" ${mediaTypeFilter === "general" ? "selected" : ""}>General</option>
            </select>
          </div>
          <div class="admin-field">
            <label>Status</label>
            <select onchange="MediaLibraryAdmin.setActiveFilter(this.value)">
              <option value="active" ${mediaActiveFilter === "active" ? "selected" : ""}>Active</option>
              <option value="inactive" ${mediaActiveFilter === "inactive" ? "selected" : ""}>Inactive</option>
              <option value="all" ${mediaActiveFilter === "all" ? "selected" : ""}>All</option>
            </select>
          </div>
        </div>
        <div class="admin-message ${msgClass}">${esc(mediaMessage)}</div>
        ${mediaLoading ? `<p class="admin-muted">Loading media…</p>` : ""}
        ${
          !mediaLoading && !rows.length
            ? `<div class="admin-card featured-cruise-empty"><p class="admin-muted">No images yet. Upload the first one.</p></div>`
            : `<div class="media-library-grid">${rows.map(renderMediaCard).join("")}</div>`
        }
      </div>
      ${renderMediaPickerModal()}
    `;
  }

  function pickerCandidateRows() {
    const opts = pickerOptions || {};
    let rows = mediaItems.filter((m) => m.is_active !== false);
    if (opts.mediaType) rows = rows.filter((m) => m.media_type === opts.mediaType || pickerFilter === "all");

    const q = pickerSearch.trim().toLowerCase();
    if (q) {
      rows = rows.filter((row) => {
        const hay = [
          row.title,
          row.alt_text,
          row.destination_name,
          row.port_name,
          ...(row.tags || []),
          row.ci_cruise_ships?.name
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
    }

    if (pickerFilter === "current_ship" && opts.shipId) {
      rows = rows.filter((m) => m.ship_id === opts.shipId);
    } else if (pickerFilter === "current_destination" && opts.destinationHints?.length) {
      const hints = opts.destinationHints.map((h) => String(h).toLowerCase());
      rows = rows.filter((m) => hints.includes(String(m.destination_name || "").toLowerCase()));
    } else if (pickerFilter === "ships") {
      rows = rows.filter((m) => m.media_type === "ship");
    } else if (pickerFilter === "destinations") {
      rows = rows.filter((m) => m.media_type === "destination");
    } else if (pickerFilter === "ports") {
      rows = rows.filter((m) => m.media_type === "port");
    } else if (pickerFilter === "general") {
      rows = rows.filter((m) => m.media_type === "general");
    } else if (pickerFilter === "recommended") {
      const shipId = opts.shipId;
      const hints = (opts.destinationHints || []).map((h) => String(h).toLowerCase());
      rows = [...rows].sort((a, b) => {
        const score = (m) => {
          let s = 0;
          if (shipId && m.ship_id === shipId) s += 100;
          if (m.is_default) s += 20;
          if (hints.includes(String(m.destination_name || "").toLowerCase())) s += 50;
          if (opts.selectedId && m.id === opts.selectedId) s += 200;
          return s;
        };
        return score(b) - score(a);
      });
    }

    if (opts.mediaType && pickerFilter === "recommended") {
      // Prefer matching type but still allow related destination/ship images.
      rows = [...rows].sort((a, b) => {
        const aMatch = a.media_type === opts.mediaType ? 1 : 0;
        const bMatch = b.media_type === opts.mediaType ? 1 : 0;
        return bMatch - aMatch;
      });
    }
    return rows;
  }

  function renderMediaPickerModal() {
    if (!pickerOpen) return "";
    if (pickerUploadMode) {
      return `
        <div class="media-picker-overlay" onclick="if(event.target===this)MediaLibraryAdmin.closePicker()">
          <div class="media-picker-modal" role="dialog" aria-modal="true">
            <div class="newsletter-preview-modal-header">
              <h3>Upload New Image</h3>
              <button type="button" class="admin-button secondary small" onclick="MediaLibraryAdmin.closePickerUpload()">Back</button>
            </div>
            <div class="media-picker-body">
              ${
                mediaMessage && !(mediaSaving || /^(Uploading|Saving)/i.test(String(mediaMessage || "")))
                  ? `<div class="admin-message ${mediaMessageTone === "error" ? "admin-error" : mediaMessageTone === "success" ? "admin-success" : ""}">${esc(mediaMessage)}</div>`
                  : ""
              }
              ${renderUploadForm({ compact: true })}
              <div class="admin-actions-row" style="justify-content:flex-end;margin-top:16px;align-items:center">
                <button class="admin-button black" onclick="MediaLibraryAdmin.submitPickerUpload()" ${mediaSaving ? "disabled" : ""}>${mediaSaving ? "Uploading…" : "Upload & Use"}</button>
                ${
                  mediaSaving || /^(Uploading|Saving)/i.test(String(mediaMessage || ""))
                    ? `<span class="admin-running-status" role="status" aria-live="polite">${esc(mediaMessage)}</span>`
                    : ""
                }
              </div>
            </div>
          </div>
        </div>
      `;
    }

    const rows = pickerCandidateRows();
    const selected = mediaItems.find((m) => m.id === pickerSelectedId) || rows[0] || null;
    if (selected && !pickerSelectedId) pickerSelectedId = selected.id;

    return `
      <div class="media-picker-overlay" onclick="if(event.target===this)MediaLibraryAdmin.closePicker()">
        <div class="media-picker-modal" role="dialog" aria-modal="true" aria-labelledby="mediaPickerTitle">
          <div class="newsletter-preview-modal-header">
            <h3 id="mediaPickerTitle">${esc(pickerOptions?.title || "Choose Image")}</h3>
            <div class="admin-actions-row">
              <button type="button" class="admin-button secondary small" onclick="MediaLibraryAdmin.openPickerUpload()">Upload New</button>
              <button type="button" class="admin-button secondary small" onclick="MediaLibraryAdmin.closePicker()">Cancel</button>
            </div>
          </div>
          <div class="media-picker-body">
            <div class="media-picker-toolbar">
              <input type="search" value="${esc(pickerSearch)}" placeholder="Search images…" oninput="MediaLibraryAdmin.setPickerSearch(this.value)">
              <div class="media-picker-filters">
                ${["recommended", "current_ship", "current_destination", "ships", "destinations", "ports", "general", "all"]
                  .map((f) => {
                    const labels = {
                      recommended: "Recommended",
                      current_ship: "Current Ship",
                      current_destination: "Current Destination",
                      ships: "Ships",
                      destinations: "Destinations",
                      ports: "Ports",
                      general: "General",
                      all: "All"
                    };
                    return `<button type="button" class="media-filter-chip ${pickerFilter === f ? "is-active" : ""}" onclick="MediaLibraryAdmin.setPickerFilter('${f}')">${labels[f]}</button>`;
                  })
                  .join("")}
              </div>
            </div>
            <div class="media-picker-layout">
              <div class="media-picker-grid">
                ${
                  rows.length
                    ? rows
                        .map(
                          (row) => `
                  <button type="button" class="media-picker-thumb ${row.id === pickerSelectedId ? "is-selected" : ""}" onclick="MediaLibraryAdmin.selectPickerThumb('${esc(row.id)}')">
                    <img src="${esc(row.public_url)}" alt="" loading="lazy">
                    <span>${esc(row.title)}</span>
                  </button>`
                        )
                        .join("")
                    : `<p class="admin-muted">No matching images.</p>`
                }
              </div>
              <div class="media-picker-detail">
                ${
                  selected
                    ? `
                  <div class="media-picker-detail-preview"><img src="${esc(selected.public_url)}" alt="${esc(selected.alt_text || selected.title)}"></div>
                  <h4>${esc(selected.title)}</h4>
                  <p class="admin-small">${esc(mediaTypeLabel(selected.media_type))}${associationLabel(selected) ? ` · ${esc(associationLabel(selected))}` : ""}</p>
                  <p class="admin-muted">${esc(selected.alt_text || "No alt text")}</p>
                  <p class="admin-small">${esc((selected.tags || []).join(", ") || "No tags")}</p>
                  <button type="button" class="admin-button black" onclick="MediaLibraryAdmin.confirmPickerSelection()">Use This Image</button>
                `
                    : `<p class="admin-muted">Select an image to preview.</p>`
                }
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function openMediaPicker(options = {}) {
    pickerOpen = true;
    pickerOptions = options;
    pickerSelectedId = options.selectedId || null;
    pickerFilter = options.defaultFilter || "recommended";
    pickerSearch = "";
    pickerUploadMode = false;
    mediaMessage = "";
    if (!mediaItems.length) loadMediaLibrary({ quiet: true });
    else if (typeof global.renderAdmin === "function") global.renderAdmin();
  }

  function closePicker() {
    pickerOpen = false;
    pickerOptions = null;
    pickerSelectedId = null;
    pickerUploadMode = false;
    if (typeof global.renderAdmin === "function") global.renderAdmin();
  }

  function confirmPickerSelection() {
    const row = mediaItems.find((m) => m.id === pickerSelectedId);
    if (!row || !pickerOptions?.onSelect) return;
    const cb = pickerOptions.onSelect;
    closePicker();
    cb(row);
  }

  async function submitPickerUpload() {
    const media = await submitMediaUpload({ selectForPicker: true });
    if (media && pickerOptions?.onSelect) {
      const cb = pickerOptions.onSelect;
      closePicker();
      cb(media);
    }
  }

  function openPickerUpload() {
    captureUploadDraftFromDom();
    resetUploadDraft({
      media_type: pickerOptions?.mediaType || "general",
      ship_id: pickerOptions?.shipId || "",
      cruise_line_id: pickerOptions?.cruiseLineId || "",
      destination_name: (pickerOptions?.destinationHints || [])[0] || "",
      is_default: false
    });
    pickerUploadMode = true;
    if (typeof global.renderAdmin === "function") global.renderAdmin();
  }

  global.MediaLibraryAdmin = {
    ensureLoaded: loadMediaLibrary,
    renderPanel: renderMediaLibraryPanel,
    renderPickerModal: renderMediaPickerModal,
    openMediaPicker,
    closePicker,
    isPickerOpen: () => pickerOpen,
    getMediaItems: () => mediaItems,
    findById: (id) => mediaItems.find((m) => m.id === id) || null,
    startUpload() {
      editingMediaId = null;
      showMediaUpload = true;
      resetUploadDraft({ media_type: "general" });
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    cancelUpload() {
      showMediaUpload = false;
      resetUploadDraft();
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    onMediaFileChosen,
    submitMediaUpload: () => submitMediaUpload(),
    submitPickerUpload,
    openPickerUpload,
    closePickerUpload() {
      pickerUploadMode = false;
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    onUploadLineChange() {
      captureUploadDraftFromDom();
      uploadDraft.ship_id = "";
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    setSearch(value) {
      mediaSearchQuery = value;
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    setTypeFilter(value) {
      mediaTypeFilter = value;
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    setActiveFilter(value) {
      mediaActiveFilter = value;
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    openMediaEditor,
    closeEditor() {
      editingMediaId = null;
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    onMediaCardKeydown,
    saveMediaEditor,
    deleteMediaEditor,
    replaceMediaImage,
    setMediaAsDefault,
    setPickerSearch(value) {
      pickerSearch = value;
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    setPickerFilter(value) {
      pickerFilter = value;
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    selectPickerThumb(id) {
      pickerSelectedId = id;
      if (typeof global.renderAdmin === "function") global.renderAdmin();
    },
    confirmPickerSelection
  };
})(typeof window !== "undefined" ? window : globalThis);
