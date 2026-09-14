/* Ship Spotlight feature-category tools.
 * - guarantees both newsletter feature-column headings are visible
 * - lets Admin move a ship item between Exclusive Areas and Specialty Features
 *   without retyping the title/description.
 */
(function (global) {
  "use strict";

  const STYLE_ID = "ssFeatureToolsStyles";
  const UI_ATTR = "data-ss-feature-tools";
  const TITLE_STYLE = "font-family:Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;color:#245C4E;margin-bottom:7px;";
  const KEYS = {
    exclusive: ["exclusive_areas", "exclusiveAreas", "exclusive"],
    specialty: ["specialty_features", "specialtyFeatures", "signature_features"]
  };
  let mountToken = 0;
  let moving = false;
  let lastFacilities = null;
  let lastShipId = "";

  function esc(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function root() {
    return document.getElementById("shipSpotlightOverlay");
  }

  function selectedShipId() {
    return String(root()?.querySelector(".ss-selector select")?.value || "").trim();
  }

  function featureSection() {
    return Array.from(root()?.querySelectorAll("section") || []).find((section) => {
      const heading = section.querySelector("h3");
      return /^areas\s*&\s*features$/i.test(String(heading?.textContent || "").trim());
    }) || null;
  }

  function facilitiesApi() {
    return global.CiShipFacilities || null;
  }

  function normalizeEntry(entry) {
    const api = facilitiesApi();
    if (api?.normalizeShipFeatureEntry) return api.normalizeShipFeatureEntry(entry);
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const name = String(entry.name || entry.label || "").trim();
      return name ? { name, description: String(entry.description || "").trim() } : null;
    }
    const name = String(entry == null ? "" : entry).trim();
    return name ? { name, description: "" } : null;
  }

  function compareName(value) {
    const api = facilitiesApi();
    if (api?.normalizeCompareText) return api.normalizeCompareText(value);
    return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
  }

  function readRawList(facilities, kind) {
    const source = facilities && typeof facilities === "object" ? facilities : {};
    for (const key of KEYS[kind]) {
      if (Array.isArray(source[key])) return source[key].slice();
    }
    return [];
  }

  function displayRows(facilities, kind) {
    return readRawList(facilities, kind)
      .map((raw, rawIndex) => ({ raw, rawIndex, item: normalizeEntry(raw) }))
      .filter((row) => row.item?.name);
  }

  function canonicalizeFeatureKeys(facilities, exclusive, specialty) {
    const next = { ...(facilities && typeof facilities === "object" ? facilities : {}) };
    [...KEYS.exclusive, ...KEYS.specialty].forEach((key) => delete next[key]);
    if (exclusive.length) next.exclusive_areas = exclusive;
    if (specialty.length) next.specialty_features = specialty;
    return next;
  }

  async function fetchFacilities(shipId) {
    const db = global.supabaseClient;
    if (!db || !shipId) throw new Error("Ship data is unavailable.");
    const result = await db
      .from("ci_cruise_ships")
      .select("id,facilities")
      .eq("id", shipId)
      .single();
    if (result.error) throw result.error;
    return result.data?.facilities && typeof result.data.facilities === "object"
      ? result.data.facilities
      : {};
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .ss-feature-tools-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:12px}
      .ss-feature-tools-col{border:1px solid #e1e5e7;border-radius:9px;background:#fff;padding:12px}
      .ss-feature-tools-col h4{margin:0 0 9px!important}
      .ss-feature-move-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid #eef0f1}
      .ss-feature-move-row:first-of-type{border-top:0}
      .ss-feature-move-name{font-size:12px;line-height:1.35;color:#222;min-width:0}
      .ss-feature-move-btn{white-space:nowrap;flex:0 0 auto}
      .ss-feature-tools-status{font-size:12px;margin-top:9px;color:#545454}
      .ss-feature-tools-status.error{color:#9a2525}
      .ss-feature-tools-status.success{color:#17633f}
      @media(max-width:760px){.ss-feature-tools-grid{grid-template-columns:1fr}.ss-feature-move-row{align-items:flex-start;flex-direction:column}.ss-feature-move-btn{width:100%}}
    `;
    document.head.appendChild(style);
  }

  function editorSnapshot() {
    const panel = root();
    if (!panel) return null;
    return {
      eyebrow: panel.querySelector("#ssEyebrow")?.value || "",
      heading: panel.querySelector("#ssHeading")?.value || "",
      intro: panel.querySelector("#ssIntro")?.value || "",
      slug: panel.querySelector("#ssSlug")?.value || "",
      hero: panel.querySelector("#ssHero")?.value || "",
      published: Boolean(panel.querySelector("#ssPublished")?.checked)
    };
  }

  function restoreEditorSnapshot(snapshot) {
    const panel = root();
    if (!panel || !snapshot) return;
    const values = {
      ssEyebrow: snapshot.eyebrow,
      ssHeading: snapshot.heading,
      ssIntro: snapshot.intro,
      ssSlug: snapshot.slug,
      ssHero: snapshot.hero
    };
    Object.entries(values).forEach(([id, value]) => {
      const el = panel.querySelector(`#${id}`);
      if (el) el.value = value;
    });
    const published = panel.querySelector("#ssPublished");
    if (published) published.checked = snapshot.published;
    global.ShipSpotlightAdmin?.capture?.();
  }

  function rowHtml(kind, row) {
    const exclusive = kind === "exclusive";
    return `<div class="ss-feature-move-row">
      <div class="ss-feature-move-name"><strong>${esc(row.item.name)}</strong></div>
      <button type="button" class="admin-button secondary small ss-feature-move-btn" data-ss-move-feature="${exclusive ? "exclusive" : "specialty"}" data-ss-feature-index="${row.rawIndex}">${exclusive ? "Move to Specialty →" : "← Move to Exclusive"}</button>
    </div>`;
  }

  function renderTools(section, shipId, facilities) {
    const original = section.querySelector(":scope > .ss-grid.two");
    if (original) original.style.display = "none";

    let ui = section.querySelector(`[${UI_ATTR}]`);
    if (!ui) {
      ui = document.createElement("div");
      ui.setAttribute(UI_ATTR, "1");
      section.appendChild(ui);
    }
    ui.dataset.shipId = shipId;

    const exclusive = displayRows(facilities, "exclusive");
    const specialty = displayRows(facilities, "specialty");
    ui.innerHTML = `<div class="ss-feature-tools-grid">
      <div class="ss-feature-tools-col">
        <h4>Exclusive Areas</h4>
        ${exclusive.length ? exclusive.map((row) => rowHtml("exclusive", row)).join("") : '<p class="admin-muted">None recorded.</p>'}
      </div>
      <div class="ss-feature-tools-col">
        <h4>Specialty Features</h4>
        ${specialty.length ? specialty.map((row) => rowHtml("specialty", row)).join("") : '<p class="admin-muted">None recorded.</p>'}
      </div>
    </div><div class="ss-feature-tools-status" data-ss-feature-tools-status></div>`;
  }

  function setToolStatus(message, tone) {
    const node = featureSection()?.querySelector("[data-ss-feature-tools-status]");
    if (!node) return;
    node.textContent = message || "";
    node.className = `ss-feature-tools-status${tone ? ` ${tone}` : ""}`;
  }

  async function mountTools() {
    ensureStyles();
    const section = featureSection();
    const shipId = selectedShipId();
    if (!section || !shipId) return;
    const existing = section.querySelector(`[${UI_ATTR}]`);
    if (existing?.dataset.shipId === shipId) return;

    const token = ++mountToken;
    let loading = existing;
    if (!loading) {
      loading = document.createElement("div");
      loading.setAttribute(UI_ATTR, "1");
      loading.innerHTML = '<p class="admin-muted">Loading feature categories…</p>';
      section.appendChild(loading);
    }
    loading.dataset.shipId = shipId;

    try {
      const facilities = await fetchFacilities(shipId);
      if (token !== mountToken || selectedShipId() !== shipId) return;
      lastFacilities = facilities;
      lastShipId = shipId;
      renderTools(section, shipId, facilities);
    } catch (error) {
      if (token !== mountToken) return;
      loading.innerHTML = `<p class="admin-muted">Could not load feature categories: ${esc(error?.message || String(error))}</p>`;
    }
  }

  async function moveFeature(sourceKind, rawIndex) {
    if (moving) return;
    const shipId = selectedShipId();
    if (!shipId) return;
    const snapshot = editorSnapshot();
    moving = true;
    setToolStatus("Moving feature…", "");
    root()?.querySelectorAll("[data-ss-move-feature]").forEach((button) => { button.disabled = true; });

    try {
      const facilities = await fetchFacilities(shipId);
      const exclusive = readRawList(facilities, "exclusive");
      const specialty = readRawList(facilities, "specialty");
      const source = sourceKind === "exclusive" ? exclusive : specialty;
      const destination = sourceKind === "exclusive" ? specialty : exclusive;
      const item = source[Number(rawIndex)];
      const normalized = normalizeEntry(item);
      if (!item || !normalized?.name) throw new Error("That feature could not be found. Refresh and try again.");

      source.splice(Number(rawIndex), 1);
      const nameKey = compareName(normalized.name);
      const alreadyThere = destination.some((entry) => compareName(normalizeEntry(entry)?.name) === nameKey);
      if (!alreadyThere) destination.push(item);

      const nextFacilities = canonicalizeFeatureKeys(facilities, exclusive, specialty);
      const result = await global.supabaseClient
        .from("ci_cruise_ships")
        .update({ facilities: nextFacilities })
        .eq("id", shipId)
        .select("id,facilities")
        .single();
      if (result.error) throw result.error;

      lastFacilities = result.data?.facilities || nextFacilities;
      lastShipId = shipId;
      setToolStatus(`${normalized.name} moved to ${sourceKind === "exclusive" ? "Specialty Features" : "Exclusive Areas"}.`, "success");

      // Refresh the Ship Spotlight's in-memory ship record so the newsletter and
      // dynamic-page previews immediately reflect the new category. Restore any
      // unsaved Spotlight text fields after the refresh.
      if (typeof global.ShipSpotlightAdmin?.ensureLoaded === "function") {
        await global.ShipSpotlightAdmin.ensureLoaded(true);
        restoreEditorSnapshot(snapshot);
      }
      mountToken += 1;
      setTimeout(mountTools, 0);
    } catch (error) {
      console.error("Ship feature move failed", error);
      setToolStatus(`Move failed: ${error?.message || String(error)}`, "error");
      root()?.querySelectorAll("[data-ss-move-feature]").forEach((button) => { button.disabled = false; });
    } finally {
      moving = false;
    }
  }

  function ensureTitle(col, title) {
    if (!col) return;
    const existing = Array.from(col.children || []).find((node) =>
      node.tagName === "DIV" && /exclusive areas|specialty features/i.test(String(node.textContent || "").trim())
    );
    if (existing) {
      existing.textContent = title;
      existing.setAttribute("style", TITLE_STYLE);
      return;
    }
    const heading = document.createElement("div");
    heading.className = "cr101-ss-feature-title";
    heading.textContent = title;
    heading.setAttribute("style", TITLE_STYLE);
    col.insertBefore(heading, col.firstChild);
  }

  function ensureNewsletterFeatureTitles(rootNode) {
    if (!rootNode?.querySelectorAll) return rootNode;
    const cols = Array.from(rootNode.querySelectorAll(".cr101-ss-feature-col"))
      .filter((col) => String(col.textContent || "").trim());
    if (cols.length >= 2) {
      ensureTitle(cols[0], "Exclusive Areas");
      ensureTitle(cols[1], "Specialty Features");
    } else if (cols.length === 1) {
      const existing = String(cols[0].textContent || "");
      if (/exclusive areas/i.test(existing)) ensureTitle(cols[0], "Exclusive Areas");
      else if (/specialty features/i.test(existing)) ensureTitle(cols[0], "Specialty Features");
      else if (lastShipId === selectedShipId() && lastFacilities) {
        const hasExclusive = displayRows(lastFacilities, "exclusive").length > 0;
        const hasSpecialty = displayRows(lastFacilities, "specialty").length > 0;
        if (hasSpecialty && !hasExclusive) ensureTitle(cols[0], "Specialty Features");
        else if (hasExclusive) ensureTitle(cols[0], "Exclusive Areas");
      }
    }
    return rootNode;
  }

  function ensureTitlesHtml(html) {
    const source = String(html || "");
    if (!source.includes("cr101-ss-feature-col")) return source;
    const holder = document.createElement("div");
    holder.innerHTML = source;
    ensureNewsletterFeatureTitles(holder);
    return holder.innerHTML;
  }

  function installEmailWrapper() {
    const api = global.ShipSpotlightAdmin;
    if (!api || typeof api.emailHtml !== "function" || api.__featureTitleFixInstalled) return;
    const original = api.emailHtml.bind(api);
    api.emailHtml = function () {
      return ensureTitlesHtml(original());
    };
    api.__featureTitleFixInstalled = true;
  }

  function refreshMountedPreview() {
    document.querySelectorAll(".ss-preview-canvas").forEach(ensureNewsletterFeatureTitles);
  }

  function refresh() {
    installEmailWrapper();
    mountTools();
    refreshMountedPreview();
  }

  if (!global.__ssFeatureMoveClickInstalled) {
    document.addEventListener("click", (event) => {
      const button = event.target?.closest?.("[data-ss-move-feature]");
      if (!button || !root()?.contains(button)) return;
      event.preventDefault();
      event.stopPropagation();
      moveFeature(button.dataset.ssMoveFeature, Number(button.dataset.ssFeatureIndex));
    }, true);
    global.__ssFeatureMoveClickInstalled = true;
  }

  document.addEventListener("change", (event) => {
    if (event.target === root()?.querySelector(".ss-selector select")) {
      mountToken += 1;
      lastFacilities = null;
      lastShipId = "";
      setTimeout(refresh, 0);
    }
  }, true);

  refresh();
  new MutationObserver(() => {
    // Keep this bounded and idempotent; both helpers return immediately once mounted.
    refresh();
  }).observe(document.documentElement, { childList: true, subtree: true });

  global.ShipSpotlightFeatureTools = { moveFeature, refresh, ensureTitlesHtml };
})(window);
