/* Ship Spotlight Paul's Tip bridge.
 *
 * Paul's Tip remains canonical in research_content. This helper surfaces that
 * field in Marketing -> Ship Spotlight, saves edits back to Research Content,
 * and includes the tip directly beneath the newsletter overview when present.
 */
(function (global) {
  "use strict";

  const RESEARCH_ENDPOINT = "/.netlify/functions/research-content";
  const FIELD_ATTR = "data-ss-pauls-tip-field";
  const EMAIL_MARKER = 'data-cr101-pauls-tip="1"';
  const statusPriority = { published: 0, reviewed: 1, draft: 2, failed: 3, archived: 4 };

  let tipState = {
    shipId: "",
    researchId: "",
    value: "",
    savedValue: "",
    loading: false,
    saving: false
  };
  let loadToken = 0;
  let saveTimer = null;
  let installedEmailWrapper = false;
  let installedCopyWrapper = false;

  function overlay() {
    const el = document.getElementById("shipSpotlightOverlay");
    return el && !el.hidden ? el : null;
  }

  function selectedShipId() {
    return String(overlay()?.querySelector(".ss-selector select")?.value || "").trim();
  }

  function tipField() {
    return overlay()?.querySelector("#ssPaulsTip") || null;
  }

  function currentTip() {
    const field = tipField();
    if (field) return String(field.value || "").trim();
    return String(tipState.value || "").trim();
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function emailText(value) {
    return escapeHtml(value).replace(/\r?\n/g, "<br>");
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

  function setFieldStatus(text, tone) {
    const node = overlay()?.querySelector("[data-ss-pauls-tip-status]");
    if (!node) return;
    node.textContent = text || "";
    node.style.color = tone === "error" ? "#9a2525" : tone === "success" ? "#17633f" : "#66727c";
  }

  function chooseResearchRow(rows) {
    return (rows || []).slice().sort((a, b) => {
      const pa = statusPriority[String(a?.content_status || "")] ?? 9;
      const pb = statusPriority[String(b?.content_status || "")] ?? 9;
      return pa - pb;
    })[0] || null;
  }

  async function loadTipForShip(shipId) {
    shipId = String(shipId || "").trim();
    const token = ++loadToken;
    clearTimeout(saveTimer);
    if (!shipId) {
      tipState = { shipId: "", researchId: "", value: "", savedValue: "", loading: false, saving: false };
      return;
    }

    tipState = { shipId, researchId: "", value: "", savedValue: "", loading: true, saving: false };
    injectField();
    setFieldStatus("Loading Paul's Tip from Research Content…", "");

    try {
      const db = global.supabaseClient;
      if (!db) throw new Error("Research Content is unavailable. Reload Admin and try again.");
      const result = await db
        .from("research_content")
        .select("id,entity_id,content_status,pauls_tip,updated_at")
        .eq("entity_type", "ship")
        .eq("entity_id", shipId)
        .order("updated_at", { ascending: false })
        .limit(10);
      if (result.error) throw result.error;
      if (token !== loadToken || selectedShipId() !== shipId) return;

      const row = chooseResearchRow(result.data || []);
      const value = String(row?.pauls_tip || "");
      tipState = {
        shipId,
        researchId: String(row?.id || ""),
        value,
        savedValue: value.trim(),
        loading: false,
        saving: false
      };
      injectField(true);
      if (row) setFieldStatus("Synced with Paul's Tip in Research Content.", "");
      else setFieldStatus("No Research Content record exists for this ship yet.", "error");
    } catch (error) {
      if (token !== loadToken) return;
      tipState.loading = false;
      setFieldStatus(`Could not load Paul's Tip: ${error?.message || String(error)}`, "error");
    }
  }

  async function syncTipNow(options) {
    const opts = options || {};
    const shipId = selectedShipId();
    if (!shipId) return false;

    const tip = currentTip().slice(0, 1000);
    tipState.value = tip;

    if (tipState.shipId !== shipId || !tipState.researchId) {
      await loadTipForShip(shipId);
      if (selectedShipId() !== shipId) return false;
      const live = tipField();
      if (live && tip) live.value = tip;
      tipState.value = tip;
    }

    if (!tipState.researchId) {
      if (tip) setFieldStatus("Create Research Content for this ship before saving Paul's Tip.", "error");
      return !tip;
    }
    if (!opts.force && tip === tipState.savedValue) return true;
    if (tipState.saving) return false;

    tipState.saving = true;
    setFieldStatus("Saving Paul's Tip to Research Content…", "");
    try {
      const response = await fetch(RESEARCH_ENDPOINT, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({
          action: "save_draft",
          id: tipState.researchId,
          pauls_tip: tip
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) {
        throw new Error(data.error || `Save failed (HTTP ${response.status})`);
      }
      tipState.savedValue = tip;
      tipState.value = tip;
      tipState.saving = false;
      setFieldStatus("Saved to Research Content.", "success");
      return true;
    } catch (error) {
      tipState.saving = false;
      setFieldStatus(`Paul's Tip was not saved: ${error?.message || String(error)}`, "error");
      return false;
    }
  }

  function scheduleSync() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => syncTipNow(), 800);
  }

  function injectField(forceValue) {
    const panel = overlay();
    if (!panel) return;
    const intro = panel.querySelector("#ssIntro");
    if (!intro) return;
    const shipId = selectedShipId();
    if (!shipId) return;

    let wrap = panel.querySelector(`[${FIELD_ATTR}]`);
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "admin-field";
      wrap.setAttribute(FIELD_ATTR, "1");
      wrap.style.marginTop = "14px";
      wrap.innerHTML = `
        <label for="ssPaulsTip">Paul's Tip</label>
        <textarea id="ssPaulsTip" rows="3" maxlength="1000" placeholder="A short personal tip or observation."></textarea>
        <div class="admin-helper" style="margin-top:5px;">This is the same Paul's Tip used in Research Content, Ship Spotlight and My Ship.</div>
        <div class="admin-small" data-ss-pauls-tip-status style="margin-top:4px;"></div>
      `;
      intro.closest(".admin-field")?.insertAdjacentElement("afterend", wrap);
      const field = wrap.querySelector("#ssPaulsTip");
      field?.addEventListener("input", () => {
        tipState.value = String(field.value || "");
        setFieldStatus("Unsaved change…", "");
        scheduleSync();
      });
      field?.addEventListener("change", () => {
        tipState.value = String(field.value || "");
        clearTimeout(saveTimer);
        syncTipNow();
      });
    }

    const field = wrap.querySelector("#ssPaulsTip");
    if (field && (forceValue || document.activeElement !== field)) {
      field.value = tipState.shipId === shipId ? String(tipState.value || "") : "";
    }
  }

  function paulsTipRow(tip) {
    if (!tip) return "";
    // Newsletter only: Paul's Tip is intentionally presented as another normal
    // overview paragraph. The labelled/highlighted treatment belongs exclusively
    // on the dynamic Ship Spotlight page.
    return `<tr ${EMAIL_MARKER}><td align="center" style="padding:12px 16px 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:400;color:#111111;text-align:center;line-height:1.65;">${emailText(tip)}</td></tr>`;
  }

  function transformNewsletterHtml(html) {
    const source = String(html || "");
    if (!source || !source.includes("cr101-ss-wrapper")) return source;
    if (source.includes(EMAIL_MARKER)) return source;
    const tip = currentTip();
    if (!tip) return source;

    const markerTexts = [
      ">ROOM TYPES</div>",
      ">SHIP AT A GLANCE</div>",
      ">ON BOARD</div>",
      'class="cr101-ss-features"'
    ];
    let insertAt = -1;
    markerTexts.forEach((marker) => {
      const idx = source.indexOf(marker);
      if (idx < 0) return;
      const rowStart = source.lastIndexOf("<tr", idx);
      if (rowStart >= 0 && (insertAt < 0 || rowStart < insertAt)) insertAt = rowStart;
    });
    if (insertAt < 0) return source;
    return `${source.slice(0, insertAt)}${paulsTipRow(tip)}\n${source.slice(insertAt)}`;
  }

  function installEmailWrapper() {
    const api = global.ShipSpotlightAdmin;
    if (!api || typeof api.emailHtml !== "function") return;
    if (installedEmailWrapper || api.__paulsTipEmailWrapperInstalled) return;
    const original = api.emailHtml.bind(api);
    api.emailHtml = function () {
      return transformNewsletterHtml(original());
    };
    api.__paulsTipEmailWrapperInstalled = true;
    api.syncPaulsTip = syncTipNow;
    installedEmailWrapper = true;
  }

  function installCopyWrapper() {
    const assets = global.NewsletterMailchimpAssets;
    if (!assets || typeof assets.copyHostedHtml !== "function") return;
    if (installedCopyWrapper || assets.__paulsTipCopyWrapperInstalled) return;
    const original = assets.copyHostedHtml.bind(assets);
    assets.copyHostedHtml = function (html) {
      return original(transformNewsletterHtml(html));
    };
    assets.__paulsTipCopyWrapperInstalled = true;
    installedCopyWrapper = true;
  }

  function reconcile() {
    const shipId = selectedShipId();
    if (!shipId) return;
    if (tipState.shipId !== shipId && !tipState.loading) {
      loadTipForShip(shipId);
      return;
    }
    injectField();
    installEmailWrapper();
    installCopyWrapper();
  }

  document.addEventListener("click", (event) => {
    const button = event.target?.closest?.("button");
    if (!button || !overlay()?.contains(button)) return;
    const text = String(button.textContent || "").trim();
    if (text === "Preview Newsletter Block" || text === "Copy Newsletter Block" || text === "Save Spotlight") {
      const field = tipField();
      if (field) tipState.value = String(field.value || "");
      scheduleSync();
    }
  }, false);

  installEmailWrapper();
  installCopyWrapper();
  reconcile();
  new MutationObserver(reconcile).observe(document.documentElement, { childList: true, subtree: true });

  global.ShipSpotlightPaulsTip = {
    load: loadTipForShip,
    sync: syncTipNow,
    transformNewsletterHtml
  };
})(window);
