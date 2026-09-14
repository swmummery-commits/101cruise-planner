/* Reliable Ship Spotlight preview + save/publish controls.
 * Keep this deliberately simple: preview the generated newsletter HTML directly
 * in an Admin modal. No iframe, no popup, no legacy previewOpen state.
 */
(function (global) {
  "use strict";

  const SAVE_ENDPOINT = "/.netlify/functions/admin-ship-spotlight-save";
  const PREVIEW_ID = "ssNewsletterPreviewModal";
  const STAT_KEYS = [
    "passenger_capacity", "stateroom_count", "crew_count", "year_built", "year_refurbished",
    "gross_tonnage", "length_metres", "beam_metres", "cruising_speed_knots", "deck_count"
  ];

  function root() {
    return document.getElementById("shipSpotlightOverlay");
  }

  function field(id) {
    return root()?.querySelector(`#${id}`) || null;
  }

  function selectedShipId() {
    return String(root()?.querySelector(".ss-selector select")?.value || "").trim();
  }

  function value(id) {
    return String(field(id)?.value || "").trim();
  }

  function statusNode() {
    const actions = root()?.querySelector(".ss-actions");
    if (!actions) return null;
    let node = actions.querySelector("[data-ss-action-status]");
    if (!node) {
      node = document.createElement("div");
      node.dataset.ssActionStatus = "1";
      node.className = "admin-small";
      node.style.flex = "1 0 100%";
      node.style.marginBottom = "8px";
      actions.insertBefore(node, actions.firstChild);
    }
    return node;
  }

  function setStatus(message, tone) {
    const node = statusNode();
    if (!node) return;
    node.textContent = message || "";
    node.style.color = tone === "error" ? "#9a2525" : tone === "success" ? "#17633f" : "#545454";
  }

  async function authHeaders() {
    if (typeof global.adminAuthHeaders === "function") {
      return global.adminAuthHeaders({ "Content-Type": "application/json" });
    }
    const sessionResult = await global.supabaseClient?.auth?.getSession?.();
    const token = sessionResult?.data?.session?.access_token || "";
    return {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
  }

  function savePayload() {
    return {
      ship_id: selectedShipId(),
      eyebrow: value("ssEyebrow") || "SHIP SPOTLIGHT",
      newsletter_heading: value("ssHeading"),
      editorial_intro: value("ssIntro"),
      hero_image_url: value("ssHero"),
      public_slug: value("ssSlug"),
      publication_status: field("ssPublished")?.checked ? "published" : "draft",
      stat_keys: STAT_KEYS,
      supporting_image_urls: []
    };
  }

  async function saveViaServer() {
    const body = savePayload();
    if (!body.ship_id) {
      setStatus("Select a ship first.", "error");
      return false;
    }
    if (!body.hero_image_url) {
      setStatus("Choose a hero image before saving or publishing.", "error");
      return false;
    }

    setStatus(body.publication_status === "published" ? "Publishing…" : "Saving…", "");
    try {
      const response = await fetch(SAVE_ENDPOINT, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify(body)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) {
        throw new Error(data.error || `Save failed (HTTP ${response.status})`);
      }
      setStatus(body.publication_status === "published" ? "Published successfully." : "Saved successfully.", "success");
      return data.spotlight || true;
    } catch (error) {
      console.error("Ship Spotlight save failed", error);
      setStatus(`Save failed: ${error?.message || String(error)}`, "error");
      return false;
    }
  }

  function closePreview() {
    document.getElementById(PREVIEW_ID)?.remove();
  }

  function buildPreviewHtml() {
    const api = global.ShipSpotlightAdmin;
    api?.capture?.();
    if (!selectedShipId()) throw new Error("Select a ship first.");
    if (typeof api?.emailHtml !== "function") throw new Error("Newsletter renderer is unavailable. Refresh Admin and try again.");
    const html = String(api.emailHtml() || "").trim();
    if (!html) throw new Error("Choose a hero image before previewing the newsletter block.");
    return html;
  }

  function openPreview() {
    try {
      const html = buildPreviewHtml();
      closePreview();

      const backdrop = document.createElement("div");
      backdrop.id = PREVIEW_ID;
      Object.assign(backdrop.style, {
        position: "fixed",
        inset: "0",
        zIndex: "2147483000",
        background: "rgba(17,17,17,.68)",
        overflowY: "auto",
        padding: "24px 12px"
      });

      const modal = document.createElement("div");
      Object.assign(modal.style, {
        width: "min(680px, 100%)",
        margin: "0 auto",
        background: "#ffffff",
        borderRadius: "12px",
        boxShadow: "0 18px 60px rgba(0,0,0,.30)",
        overflow: "hidden"
      });

      const header = document.createElement("div");
      Object.assign(header.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "16px",
        padding: "14px 16px",
        background: "#ffffff",
        borderBottom: "1px solid #e8e8e8"
      });
      const title = document.createElement("div");
      title.innerHTML = '<strong style="font-family:Helvetica,Arial,sans-serif;">Newsletter block preview</strong><div style="font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#545454;margin-top:3px;">Actual 600px newsletter section</div>';
      const close = document.createElement("button");
      close.type = "button";
      close.className = "admin-button secondary small";
      close.textContent = "Close";
      close.addEventListener("click", closePreview);
      header.appendChild(title);
      header.appendChild(close);

      const stage = document.createElement("div");
      stage.className = "ss-preview-canvas";
      Object.assign(stage.style, {
        width: "100%",
        background: "#f7f7f7",
        padding: "0",
        overflowX: "hidden"
      });
      stage.innerHTML = html;

      modal.appendChild(header);
      modal.appendChild(stage);
      backdrop.appendChild(modal);
      backdrop.addEventListener("click", (event) => {
        if (event.target === backdrop) closePreview();
      });
      document.body.appendChild(backdrop);
      setStatus("", "");
      return true;
    } catch (error) {
      console.error("Ship Spotlight preview failed", error);
      setStatus(`Preview failed: ${error?.message || String(error)}`, "error");
      return false;
    }
  }

  function installApi() {
    const api = global.ShipSpotlightAdmin;
    if (!api) return false;
    api.openPreview = openPreview;
    api.closePreview = closePreview;
    api.save = saveViaServer;
    return true;
  }

  // One capture-phase handler is authoritative for these controls. It does not
  // depend on button IDs or on buttons surviving a Ship Spotlight re-render.
  if (!global.__ssSimpleControlsInstalled) {
    document.addEventListener("click", (event) => {
      const button = event.target?.closest?.("button");
      const panel = root();
      if (!button || !panel?.contains(button)) return;
      const text = String(button.textContent || "").trim();

      if (text === "Preview Newsletter Block") {
        event.preventDefault();
        event.stopImmediatePropagation();
        openPreview();
        return;
      }

      if (text === "Save Spotlight") {
        event.preventDefault();
        event.stopImmediatePropagation();
        saveViaServer();
      }
    }, true);

    document.addEventListener("change", (event) => {
      if (event.target?.id !== "ssPublished") return;
      setTimeout(saveViaServer, 0);
    }, true);

    global.__ssSimpleControlsInstalled = true;
  }

  function install() {
    if (!installApi()) return;
    statusNode();
  }

  install();
  // The Ship Spotlight API is created once, but the panel contents are re-rendered.
  // Reinstalling on child-list changes only refreshes the visible status node.
  new MutationObserver(install).observe(document.documentElement, { childList: true, subtree: true });

  global.ShipSpotlightReliabilityFix = { openPreview, closePreview, saveViaServer, install };
})(window);
