/**
 * Client Reviews fields on the newsletter issue editor.
 *
 * Follows the opening-copy editor: values stay with the issue, survive
 * reopen, and are added to preview and Mailchimp HTML. Photos are uploaded
 * through the Media Library signed-upload flow, then stored in order.
 * The block is not marked as opening copy, so the specials-only export
 * guard leaves it in place.
 */
(function (global) {
  "use strict";

  const composer = global.NewsletterIssueComposer;
  const reviewsApi = global.NewsletterClientReviews;
  if (!composer || !reviewsApi || composer.__clientReviewsApplied) return;

  const MAX_PHOTOS = 12;
  const MAX_FILES_PER_DROP = 10;
  const MAX_BYTES = 10 * 1024 * 1024;

  const originals = {
    render: composer.render.bind(composer),
    saveNewsletter: composer.saveNewsletter.bind(composer),
    openNewsletterById: composer.openNewsletterById.bind(composer),
    selectIssueNumber: composer.selectIssueNumber.bind(composer),
    startNewNewsletter: composer.startNewNewsletter.bind(composer),
    preview: composer.preview.bind(composer),
    exportHtml: composer.exportHtml.bind(composer),
    printRecord: composer.printRecord?.bind(composer)
  };

  const savedReviews = new Map();
  const editorDrafts = new Map();
  const loadingReviews = new Map();
  const loadFailed = new Set();
  let localMessage = "";
  let localMessageTone = "";
  let uploading = false;
  let dragFromHandle = false;

  function esc(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function publicError(error) {
    return String(error?.message || error || "Could not save client reviews.").replace(/https?:\/\/\S+/g, "[link]");
  }

  function isMissingColumn(error) {
    const text = String(error?.message || error || "");
    return /client_review_/i.test(text) && /does not exist|schema cache|column/i.test(text);
  }

  function activeNewsletter() {
    return composer.getActiveNewsletter?.() || null;
  }

  function reviewFor(active) {
    if (!active?.id) return reviewsApi.empty();
    if (editorDrafts.has(active.id)) return editorDrafts.get(active.id);
    if (savedReviews.has(active.id)) return savedReviews.get(active.id);
    return reviewsApi.empty();
  }

  function setLocalMessage(text, tone) {
    localMessage = String(text || "");
    localMessageTone = tone || "";
    const box = document.getElementById("newsletterReviewMessage");
    if (!box) return;
    box.textContent = localMessage;
    box.className = `admin-message newsletter-review-message ${
      tone === "error" ? "admin-error" : tone === "success" ? "admin-success" : ""
    }`;
    box.hidden = !localMessage;
  }

  function readEditorForm() {
    const active = activeNewsletter();
    const fallback = reviewFor(active);
    const textEl = document.getElementById("newsletterReviewText");
    return reviewsApi.normalize({
      eyebrow: document.getElementById("newsletterReviewEyebrow")?.value ?? fallback.eyebrow,
      headline: document.getElementById("newsletterReviewHeadline")?.value ?? fallback.headline,
      text: textEl?.value ?? fallback.text,
      photos: fallback.photos
    });
  }

  function captureEditorDraft() {
    const active = activeNewsletter();
    const textEl = document.getElementById("newsletterReviewText");
    if (!active?.id || !textEl || textEl.disabled) return;
    editorDrafts.set(active.id, readEditorForm());
  }

  function commitReview(partial) {
    const active = activeNewsletter();
    if (!active?.id) return reviewsApi.empty();
    const next = reviewsApi.normalize({ ...readEditorForm(), ...partial });
    editorDrafts.set(active.id, next);
    return next;
  }

  function rerender() {
    if (typeof global.renderAdmin === "function") global.renderAdmin();
  }

  async function mediaApi(action, payload = {}) {
    const headers =
      typeof global.adminAuthHeaders === "function"
        ? await global.adminAuthHeaders()
        : { "Content-Type": "application/json" };
    if (!headers["Content-Type"] && !headers["content-type"]) {
      headers["Content-Type"] = "application/json";
    }
    const response = await fetch("/.netlify/functions/media-library", {
      method: "POST",
      headers,
      body: JSON.stringify({ action, ...payload })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      throw new Error(publicError(data.error || `Media library request failed (${response.status})`));
    }
    return data;
  }

  function fileTitleStem(fileName) {
    return String(fileName || "Review photo").replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Review photo";
  }

  async function prepareUploadFile(file) {
    const allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    const type = String(file?.type || "").toLowerCase();
    if (!allowed.includes(type)) {
      throw new Error("Unsupported file type. Use JPG, PNG or WebP.");
    }
    if (!file.size || file.size > MAX_BYTES) {
      throw new Error("File too large. Maximum is 10 MB.");
    }
    let prepared = file;
    if (typeof global.resizeCiImageFile === "function") {
      prepared = await global.resizeCiImageFile(file, 2000, 0.85);
    }
    if (prepared.size > MAX_BYTES) {
      throw new Error("File still too large after optimisation (max 10 MB).");
    }
    let width = null;
    let height = null;
    if (typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(prepared);
        width = bitmap.width;
        height = bitmap.height;
        bitmap.close?.();
      } catch (_error) {
        /* Dimensions are optional. The stored image still uploads. */
      }
    }
    return { file: prepared, width, height };
  }

  async function uploadOneFile(file) {
    const prepared = await prepareUploadFile(file);
    const signed = await mediaApi("create_upload", {
      filename: file.name,
      mime_type: prepared.file.type || file.type,
      size_bytes: prepared.file.size,
      media_type: "general"
    });
    const client = global.supabaseClient;
    if (!client?.storage) throw new Error("Database client is not ready.");
    const { error: uploadError } = await client.storage
      .from(signed.bucket)
      .uploadToSignedUrl(signed.storage_path, signed.token, prepared.file, {
        contentType: prepared.file.type || file.type
      });
    if (uploadError) throw new Error(publicError(uploadError));
    const title = fileTitleStem(file.name);
    const created = await mediaApi("create_record", {
      title,
      alt_text: title,
      media_type: "general",
      storage_path: signed.storage_path,
      public_url: signed.public_url,
      file_name: file.name,
      mime_type: prepared.file.type || file.type,
      width: prepared.width,
      height: prepared.height,
      file_size_bytes: prepared.file.size,
      tags: "client-review",
      is_default: false
    });
    const photo = reviewsApi.photoFromMedia(created.media, {
      width: prepared.width,
      height: prepared.height,
      file_name: file.name,
      alt: title
    });
    if (!photo) throw new Error("The uploaded photo did not return a usable image address.");
    return photo;
  }

  async function uploadFiles(fileList) {
    const active = activeNewsletter();
    if (!active?.id || uploading) return;
    captureEditorDraft();
    const incoming = Array.from(fileList || []).filter(Boolean);
    if (!incoming.length) return;
    const room = MAX_PHOTOS - reviewFor(active).photos.length;
    if (room <= 0) {
      setLocalMessage(`You can add up to ${MAX_PHOTOS} photos.`, "error");
      return;
    }
    const batch = incoming.slice(0, Math.min(room, MAX_FILES_PER_DROP));
    const skipped = incoming.length - batch.length;

    const run = async () => {
      uploading = true;
      const added = [];
      let failure = "";
      try {
        for (let i = 0; i < batch.length; i += 1) {
          setLocalMessage(`Uploading photo ${i + 1} of ${batch.length}…`, "");
          try {
            added.push(await uploadOneFile(batch[i]));
          } catch (error) {
            failure = publicError(error);
            break;
          }
        }
        if (added.length) {
          const current = reviewFor(active);
          commitReview({ photos: current.photos.concat(added).slice(0, MAX_PHOTOS) });
        }
        if (failure) {
          setLocalMessage(
            added.length
              ? `${added.length} photo${added.length === 1 ? "" : "s"} added. The next file failed: ${failure}`
              : failure,
            "error"
          );
        } else if (skipped > 0) {
          setLocalMessage(
            `Added ${added.length} photo${added.length === 1 ? "" : "s"}. ${skipped} more ${skipped === 1 ? "was" : "were"} left out because a review can hold ${MAX_PHOTOS} photos.`,
            ""
          );
        } else {
          setLocalMessage("", "");
        }
      } finally {
        uploading = false;
      }
    };

    const loading = global.AdminLoading;
    if (loading?.withSaving) {
      await loading.withSaving(run, {
        key: "newsletter-review-photos",
        supportMessage: "Uploading review photos…"
      });
    } else {
      await run();
    }
    rerender();
  }

  async function hydrateNewsletter(newsletterId, { rerenderOnLoad = true } = {}) {
    if (!newsletterId) return reviewsApi.empty();
    if (savedReviews.has(newsletterId)) return savedReviews.get(newsletterId);
    if (loadFailed.has(newsletterId)) return editorDrafts.get(newsletterId) || reviewsApi.empty();
    if (loadingReviews.has(newsletterId)) return loadingReviews.get(newsletterId);

    const promise = (async () => {
      const client = global.supabaseClient;
      if (!client) return reviewsApi.empty();
      const { data, error } = await client
        .from("newsletters")
        .select("id,client_review_eyebrow,client_review_headline,client_review_text,client_review_photos")
        .eq("id", newsletterId)
        .single();
      if (error) {
        loadFailed.add(newsletterId);
        if (!isMissingColumn(error)) {
          console.warn("Newsletter client reviews could not be loaded.");
          setLocalMessage("Client reviews could not be loaded. The rest of this newsletter is unchanged.", "error");
        }
        return editorDrafts.get(newsletterId) || reviewsApi.empty();
      }
      const value = reviewsApi.normalize(data);
      savedReviews.set(newsletterId, value);
      if (
        rerenderOnLoad &&
        !editorDrafts.has(newsletterId) &&
        activeNewsletter()?.id === newsletterId &&
        typeof global.renderAdmin === "function"
      ) {
        global.renderAdmin();
      }
      return value;
    })().finally(() => loadingReviews.delete(newsletterId));

    loadingReviews.set(newsletterId, promise);
    return promise;
  }

  async function ensureActiveHydrated() {
    const active = activeNewsletter();
    if (!active?.id) return reviewsApi.empty();
    if (editorDrafts.has(active.id)) return editorDrafts.get(active.id);
    return hydrateNewsletter(active.id, { rerenderOnLoad: false });
  }

  function payloadFor(review) {
    const value = reviewsApi.normalize(review);
    return {
      client_review_eyebrow: value.eyebrow,
      client_review_headline: value.headline,
      client_review_text: value.text,
      client_review_photos: value.photos
    };
  }

  function editorHtml(review, loading) {
    const disabled = loading || uploading ? "disabled" : "";
    const photos = review.photos || [];
    const photoCards = photos
      .map(
        (photo, index) => `
        <article
          class="nl-review-photo-card"
          draggable="true"
          data-review-photo-id="${esc(photo.id)}"
          ondragstart="NewsletterClientReviewsAdmin.onPhotoDragStart(event, '${esc(photo.id)}')"
          ondragend="NewsletterClientReviewsAdmin.onPhotoDragEnd(event)"
        >
          <button type="button" class="newsletter-issue-handle" aria-label="Drag to reorder photo ${index + 1}" title="Drag to reorder" onmousedown="NewsletterClientReviewsAdmin.onPhotoHandleDown()">☰</button>
          <img src="${esc(photo.url)}" alt="${esc(photo.alt)}">
          <div class="nl-review-photo-meta">
            <span>Photo ${index + 1}</span>
            <button type="button" class="admin-button secondary small" onclick="NewsletterClientReviewsAdmin.removePhoto('${esc(photo.id)}')" ${disabled}>Remove</button>
          </div>
        </article>`
      )
      .join("");

    return `
      <section class="newsletter-client-reviews-editor" aria-label="Client reviews">
        <div class="admin-list-top">
          <div>
            <h4>Client Reviews</h4>
            <p class="admin-muted">Optional. The section is included after the specials only when the review text has something to say. Photos are optional and stay in the order you set.</p>
          </div>
          ${loading ? '<span class="admin-muted">Loading…</span>' : ""}
        </div>
        <div class="nl-review-grid">
          <div class="admin-field">
            <label for="newsletterReviewEyebrow">Eyebrow title</label>
            <input style="text-transform:uppercase" id="newsletterReviewEyebrow" type="text" value="${esc(review.eyebrow)}" ${disabled} oninput="NewsletterClientReviewsAdmin.captureEditorDraft()" autocomplete="off" placeholder="Client reviews">
          </div>
          <div class="admin-field">
            <label for="newsletterReviewHeadline">Headline</label>
            <input style="text-transform:capitalize" id="newsletterReviewHeadline" type="text" value="${esc(review.headline)}" ${disabled} oninput="NewsletterClientReviewsAdmin.captureEditorDraft()" autocomplete="off" placeholder="Short heading above the review">
          </div>
          <div class="admin-field nl-review-wide">
            <label for="newsletterReviewText">Review text</label>
            <textarea id="newsletterReviewText" rows="6" ${disabled} oninput="NewsletterClientReviewsAdmin.captureEditorDraft()" placeholder="Leave this blank to hide the whole section.">${esc(review.text)}</textarea>
            <span class="admin-helper">Blank lines start a new paragraph. If this is empty, the eyebrow, headline and photos are left out of the preview and the exported email.</span>
          </div>
        </div>
        <div class="admin-field nl-review-photos-field">
          <label>Photos</label>
          <div
            class="nl-review-drop"
            ondragenter="NewsletterClientReviewsAdmin.allowFileDrop(event)"
            ondragover="NewsletterClientReviewsAdmin.allowFileDrop(event)"
            ondragleave="NewsletterClientReviewsAdmin.onFileDragLeave(event)"
            ondrop="NewsletterClientReviewsAdmin.onFileDrop(event)"
          >
            <p>${photos.length ? "Drop more photos here, or choose files." : "Drop photos here, or choose files."}</p>
            <label class="admin-button secondary small nl-review-file-button">
              ${photos.length ? "Add more photos" : "Add photos"}
              <input id="newsletterReviewPhotoInput" type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" multiple ${disabled} onchange="NewsletterClientReviewsAdmin.onFileInput(event)">
            </label>
          </div>
          <span class="admin-helper">JPG, PNG or WebP. Up to 10 MB each, and up to ${MAX_PHOTOS} photos. Drag ☰ to reorder. Removing a photo only takes it off this newsletter.</span>
          ${
            photos.length
              ? `<div class="nl-review-photo-list" ondragover="NewsletterClientReviewsAdmin.allowPhotoDrop(event)" ondrop="NewsletterClientReviewsAdmin.onPhotoDrop(event)">${photoCards}</div>`
              : ""
          }
        </div>
        <div id="newsletterReviewMessage" class="admin-message newsletter-review-message ${
          localMessageTone === "error" ? "admin-error" : localMessageTone === "success" ? "admin-success" : ""
        }" ${localMessage ? "" : "hidden"}>${esc(localMessage)}</div>
      </section>
    `;
  }

  function enhancedRender() {
    const html = originals.render();
    if (typeof document === "undefined") return html;
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const root = tpl.content;
    const active = activeNewsletter();
    if (active?.id && !root.querySelector(".newsletter-client-reviews-editor")) {
      const loading =
        !savedReviews.has(active.id) &&
        !editorDrafts.has(active.id) &&
        !loadFailed.has(active.id);
      const anchor =
        root.querySelector(".newsletter-editorial-editor") ||
        root.querySelector(".newsletter-workspace-fields");
      if (anchor) {
        const holder = document.createElement("div");
        holder.innerHTML = editorHtml(reviewFor(active), loading);
        anchor.insertAdjacentElement("afterend", holder.firstElementChild);
        if (loading) hydrateNewsletter(active.id).catch(() => {});
      }
    }
    return tpl.innerHTML;
  }

  function allowFileDrop(event) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    event.currentTarget?.classList?.add("is-dragover");
  }

  function onFileDragLeave(event) {
    event.currentTarget?.classList?.remove("is-dragover");
  }

  function onFileDrop(event) {
    event.preventDefault();
    event.currentTarget?.classList?.remove("is-dragover");
    const files = event.dataTransfer?.files;
    if (!files?.length) return;
    uploadFiles(files).catch((error) => {
      uploading = false;
      setLocalMessage(publicError(error), "error");
      rerender();
    });
  }

  function onFileInput(event) {
    const files = event?.target?.files;
    const input = event?.target;
    uploadFiles(files)
      .catch((error) => {
        uploading = false;
        setLocalMessage(publicError(error), "error");
        rerender();
      })
      .finally(() => {
        if (input) input.value = "";
      });
  }

  function onPhotoHandleDown() {
    dragFromHandle = true;
  }

  function onPhotoDragStart(event, photoId) {
    if (!dragFromHandle) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", photoId);
    event.currentTarget.classList.add("is-dragging");
  }

  function onPhotoDragEnd(event) {
    event.currentTarget?.classList?.remove("is-dragging");
    dragFromHandle = false;
  }

  function allowPhotoDrop(event) {
    if (event.dataTransfer?.files?.length) {
      allowFileDrop(event);
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const list = event.currentTarget;
    const dragged = list.querySelector(".nl-review-photo-card.is-dragging");
    if (!dragged) return;
    const cards = Array.from(list.querySelectorAll(".nl-review-photo-card:not(.is-dragging)"));
    const after = cards.find((card) => {
      const rect = card.getBoundingClientRect();
      return event.clientY < rect.top + rect.height / 2;
    });
    if (after) list.insertBefore(dragged, after);
    else list.appendChild(dragged);
  }

  function onPhotoDrop(event) {
    if (event.dataTransfer?.files?.length) {
      onFileDrop(event);
      return;
    }
    event.preventDefault();
    const list = event.currentTarget;
    const orderedIds = Array.from(list.querySelectorAll("[data-review-photo-id]")).map(
      (card) => card.getAttribute("data-review-photo-id")
    );
    const current = readEditorForm();
    commitReview({ photos: reviewsApi.orderPhotos(current.photos, orderedIds) });
    dragFromHandle = false;
    rerender();
  }

  function removePhoto(photoId) {
    const current = readEditorForm();
    commitReview({ photos: current.photos.filter((photo) => photo.id !== photoId) });
    setLocalMessage("", "");
    rerender();
  }

  async function saveNewsletter() {
    const active = activeNewsletter();
    if (!active?.id) return originals.saveNewsletter();
    await ensureActiveHydrated();
    const review = readEditorForm();
    editorDrafts.set(active.id, review);
    const client = global.supabaseClient;
    if (!client) return originals.saveNewsletter();

    const { error } = await client.from("newsletters").update(payloadFor(review)).eq("id", active.id);
    if (error) {
      const detail = isMissingColumn(error)
        ? "Client reviews could not be saved because the database update has not been applied yet. The rest of the newsletter was still saved."
        : `Client reviews were not saved: ${publicError(error)} The rest of the newsletter was still saved.`;
      setLocalMessage(detail, "error");
    } else {
      savedReviews.set(active.id, reviewsApi.normalize(review));
      editorDrafts.delete(active.id);
      loadFailed.delete(active.id);
      if (localMessageTone === "error") setLocalMessage("", "");
    }
    return originals.saveNewsletter();
  }

  async function openNewsletterById(newsletterId) {
    localMessage = "";
    localMessageTone = "";
    const result = await originals.openNewsletterById(newsletterId);
    const active = activeNewsletter();
    if (active?.id) await hydrateNewsletter(active.id);
    return result;
  }

  async function selectIssueNumber(value) {
    localMessage = "";
    localMessageTone = "";
    const result = await originals.selectIssueNumber(value);
    const active = activeNewsletter();
    if (active?.id) await hydrateNewsletter(active.id);
    return result;
  }

  function startNewNewsletter() {
    localMessage = "";
    localMessageTone = "";
    return originals.startNewNewsletter();
  }

  function installExport() {
    const api = global.NewsletterMailchimpExport;
    if (!api?.composeIssueHtml || api.composeIssueHtml.__clientReviewsWrapped) return;
    const previous = api.composeIssueHtml.bind(api);
    const wrapped = function (payloads, options = {}) {
      const result = previous(payloads, options);
      return reviewsApi.applyToExportResult(result, reviewFor(activeNewsletter()));
    };
    wrapped.__clientReviewsWrapped = true;
    wrapped.__newsletterSetupWrapped = api.composeIssueHtml.__newsletterSetupWrapped;
    wrapped.__specialsOnlyExport = api.composeIssueHtml.__specialsOnlyExport;
    api.composeIssueHtml = wrapped;
  }

  async function preview(mode) {
    captureEditorDraft();
    await ensureActiveHydrated();
    installExport();
    return originals.preview(mode);
  }

  async function exportHtml(mode, action) {
    captureEditorDraft();
    await ensureActiveHydrated();
    installExport();
    return originals.exportHtml(mode, action);
  }

  async function printRecord() {
    captureEditorDraft();
    await ensureActiveHydrated();
    installExport();
    return originals.printRecord?.();
  }

  function exportStamp() {
    captureEditorDraft();
    return reviewsApi.exportStamp(reviewFor(activeNewsletter()));
  }

  function ensureStyles() {
    if (typeof document === "undefined" || document.getElementById("newsletterClientReviewStyles")) return;
    const style = document.createElement("style");
    style.id = "newsletterClientReviewStyles";
    style.textContent = `
      #cruise-admin-app .newsletter-client-reviews-editor{margin:16px 0 20px;padding:18px;border:1px solid #e3e7e5;border-radius:14px;background:#fff}
      #cruise-admin-app .newsletter-client-reviews-editor .admin-list-top{margin-bottom:4px}
      #cruise-admin-app .nl-review-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;align-items:end;margin-top:14px}
      #cruise-admin-app .nl-review-wide{grid-column:1 / -1}
      #cruise-admin-app .newsletter-client-reviews-editor textarea{width:100%;resize:vertical;min-height:120px}
      #cruise-admin-app .nl-review-photos-field{margin-top:16px}
      #cruise-admin-app .nl-review-drop{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:6px;padding:16px;border:1px dashed #8DD9BF;border-radius:12px;background:#f7fbf9}
      #cruise-admin-app .nl-review-drop.is-dragover{background:#eef8f3;border-color:#245C4E}
      #cruise-admin-app .nl-review-drop p{margin:0;color:#245C4E}
      #cruise-admin-app .nl-review-file-button{position:relative;overflow:hidden;cursor:pointer}
      #cruise-admin-app .nl-review-file-button input{position:absolute;inset:0;opacity:0;cursor:pointer}
      #cruise-admin-app .nl-review-photo-list{display:flex;flex-direction:column;gap:8px;margin-top:12px}
      #cruise-admin-app .nl-review-photo-card{display:grid;grid-template-columns:auto 72px minmax(0,1fr);gap:10px;align-items:center;padding:8px 10px;border:1px solid #e3e8e5;border-radius:12px;background:#fff}
      #cruise-admin-app .nl-review-photo-card.is-dragging{opacity:0.55}
      #cruise-admin-app .nl-review-photo-card img{width:72px;height:54px;object-fit:cover;border-radius:8px;background:#f3f4f6;display:block}
      #cruise-admin-app .nl-review-photo-meta{display:flex;align-items:center;justify-content:space-between;gap:8px}
      #cruise-admin-app .newsletter-review-message[hidden]{display:none}
      @media (max-width:760px){
        #cruise-admin-app .nl-review-grid{grid-template-columns:minmax(0,1fr)}
        #cruise-admin-app .nl-review-wide{grid-column:auto}
        #cruise-admin-app .nl-review-photo-card{grid-template-columns:auto 64px minmax(0,1fr)}
      }
    `;
    document.head.appendChild(style);
  }

  composer.render = enhancedRender;
  composer.saveNewsletter = saveNewsletter;
  composer.openNewsletterById = openNewsletterById;
  composer.selectIssueNumber = selectIssueNumber;
  composer.startNewNewsletter = startNewNewsletter;
  composer.preview = preview;
  composer.exportHtml = exportHtml;
  if (originals.printRecord) composer.printRecord = printRecord;
  composer.__clientReviewsApplied = true;

  global.NewsletterClientReviewsAdmin = {
    captureEditorDraft,
    allowFileDrop,
    onFileDragLeave,
    onFileDrop,
    onFileInput,
    onPhotoHandleDown,
    onPhotoDragStart,
    onPhotoDragEnd,
    allowPhotoDrop,
    onPhotoDrop,
    removePhoto,
    exportStamp,
    renderEditorSection: editorHtml,
    reviewFor: () => reviewFor(activeNewsletter()),
    payloadFor
  };

  ensureStyles();
  installExport();
})(typeof window !== "undefined" ? window : globalThis);
