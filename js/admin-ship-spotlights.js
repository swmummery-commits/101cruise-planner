/**
 * Marketing → Ship Spotlights.
 * Standalone content generator: it does not alter NewsletterIssueComposer.
 * Produces an independent Mailchimp Code Block fragment that Admin can copy/paste manually.
 */
(function (global) {
  "use strict";

  const MOUNT_ID = "shipSpotlightAdminMount";
  const NAV_ID = "admin-nav-ship-spotlights";
  const MAILCHIMP_ENDPOINT = "/.netlify/functions/ship-spotlight-mailchimp-assets";

  const state = {
    loaded: false,
    loading: false,
    busy: false,
    view: "list",
    ships: [],
    spotlights: [],
    draft: null,
    shipMedia: [],
    previewHtml: "",
    hostedHtml: "",
    message: "",
    tone: ""
  };

  function esc(value) {
    if (typeof global.esc === "function") return global.esc(value);
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function client() {
    return global.supabaseClient || null;
  }

  function renderer() {
    return global.ShipSpotlightEmail || null;
  }

  function lineName(ship) {
    return String(ship?.ci_cruise_lines?.name || "").trim();
  }

  function shipById(id) {
    return state.ships.find((row) => row.id === id) || null;
  }

  function spotlightById(id) {
    return state.spotlights.find((row) => row.id === id) || null;
  }

  function normaliseHighlights(value) {
    const list = Array.isArray(value) ? value : [];
    return [0, 1, 2, 3].map((index) =>
      String(typeof list[index] === "string" ? list[index] : list[index]?.text || "").trim()
    );
  }

  function draftFromRow(row) {
    const ship = shipById(row?.ship_id);
    return {
      id: row?.id || null,
      ship_id: row?.ship_id || "",
      eyebrow: row?.eyebrow || "SHIP OF THE WEEK",
      newsletter_heading: row?.newsletter_heading || ship?.name || "",
      editorial_intro: row?.editorial_intro || "",
      highlights: normaliseHighlights(row?.highlights),
      stat_keys:
        Array.isArray(row?.stat_keys) && row.stat_keys.length
          ? [...row.stat_keys]
          : [...(renderer()?.DEFAULT_STAT_KEYS || [])],
      hero_image_url: row?.hero_image_url || ship?.hero_image_url || "",
      supporting_image_urls: Array.isArray(row?.supporting_image_urls)
        ? [...row.supporting_image_urls]
        : [],
      public_slug: row?.public_slug || ship?.slug || "",
      publication_status: row?.publication_status || "draft",
      active: row?.active !== false
    };
  }

  function freshDraft() {
    return draftFromRow(null);
  }

  function parseGallery(value) {
    return (Array.isArray(value) ? value : [])
      .map((item) => {
        if (typeof item === "string") return { url: item, title: "Ship image", alt: "" };
        if (!item || typeof item !== "object") return null;
        return {
          url: String(item.url || item.public_url || item.image_url || "").trim(),
          title: String(item.title || item.caption || "Ship image").trim(),
          alt: String(item.alt || item.alt_text || "").trim()
        };
      })
      .filter((item) => item?.url && /^https:\/\//i.test(item.url));
  }

  function uniqueMedia(items) {
    const seen = new Set();
    return items.filter((item) => {
      const key = String(item?.url || "").split("?")[0].trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function currentUserId() {
    try {
      const result = await client()?.auth?.getUser?.();
      return result?.data?.user?.id || null;
    } catch {
      return null;
    }
  }

  async function loadData() {
    if (state.loading) return;
    const db = client();
    if (!db) throw new Error("Database client is not ready.");
    state.loading = true;
    try {
      const [shipsResult, spotlightsResult] = await Promise.all([
        db
          .from("ci_cruise_ships")
          .select(
            "id,name,slug,active,status,ship_class,year_built,year_refurbished,passenger_capacity,crew_count,deck_count,stateroom_count,gross_tonnage,length_metres,beam_metres,cruising_speed_knots,facilities,hero_image_url,image_gallery,cruise_line_id,ci_cruise_lines(id,name,slug,logo_url,active,sold_by_101cruise)"
          )
          .eq("active", true)
          .order("name", { ascending: true }),
        db
          .from("ship_spotlights")
          .select("*")
          .order("updated_at", { ascending: false })
      ]);

      if (shipsResult.error) throw shipsResult.error;
      if (spotlightsResult.error) throw spotlightsResult.error;

      state.ships = (shipsResult.data || []).filter(
        (ship) =>
          ship?.ci_cruise_lines?.active === true &&
          ship?.ci_cruise_lines?.sold_by_101cruise === true
      );
      state.spotlights = spotlightsResult.data || [];
      state.loaded = true;
    } finally {
      state.loading = false;
    }
  }

  async function loadShipMedia(shipId) {
    const ship = shipById(shipId);
    if (!ship) {
      state.shipMedia = [];
      return;
    }

    const candidates = [];
    if (ship.hero_image_url) {
      candidates.push({
        id: "canonical-hero",
        url: ship.hero_image_url,
        title: "Current ship hero",
        alt: ship.name
      });
    }
    parseGallery(ship.image_gallery).forEach((item, index) =>
      candidates.push({ id: `gallery-${index}`, ...item })
    );

    try {
      const db = client();
      const { data, error } = await db
        .from("media_library")
        .select("id,title,alt_text,public_url,media_type,is_default,is_active,ship_id")
        .eq("ship_id", shipId)
        .eq("is_active", true)
        .order("is_default", { ascending: false })
        .order("created_at", { ascending: false });
      if (!error) {
        (data || []).forEach((row) => {
          const url = String(row.public_url || "").trim();
          if (!url) return;
          candidates.push({
            id: row.id,
            url,
            title: row.title || "Media Library image",
            alt: row.alt_text || ship.name
          });
        });
      }
    } catch {
      // Canonical ship media is still enough to build a spotlight.
    }

    state.shipMedia = uniqueMedia(candidates);
  }

  function mount() {
    const nav = document.querySelector(".admin-nav");
    if (!nav) return null;

    let node = nav.nextElementSibling;
    while (node) {
      const next = node.nextElementSibling;
      node.remove();
      node = next;
    }

    const el = document.createElement("div");
    el.id = MOUNT_ID;
    nav.insertAdjacentElement("afterend", el);

    document.querySelectorAll(".admin-nav-leaf").forEach((button) => button.classList.remove("is-active"));
    document.querySelectorAll(".admin-nav-item").forEach((group) => group.classList.remove("is-active-group"));
    const own = document.getElementById(NAV_ID);
    if (own) own.classList.add("is-active");
    own?.closest(".admin-nav-item")?.classList.add("is-active-group");
    return el;
  }

  function renderMessage() {
    if (!state.message) return "";
    const cls =
      state.tone === "error"
        ? "admin-error"
        : state.tone === "success"
          ? "admin-success"
          : state.tone === "running"
            ? "admin-running"
            : "admin-muted";
    return `<div class="admin-message ${cls}" role="status">${esc(state.message)}</div>`;
  }

  function renderList() {
    const used = new Set(state.spotlights.map((row) => row.ship_id));
    return `
      <div class="admin-card ship-spotlight-admin">
        <div class="admin-list-top">
          <div>
            <p class="admin-nav-eyebrow">Marketing</p>
            <h3>Ship Spotlights</h3>
            <p class="admin-muted">Create a reusable ship feature, then copy its own Mailchimp HTML block and place it wherever you want in the newsletter.</p>
          </div>
          <button type="button" class="admin-button black" onclick="ShipSpotlightAdmin.createNew()" ${
            state.busy || used.size >= state.ships.length ? "disabled" : ""
          }>+ New Ship Spotlight</button>
        </div>
        ${renderMessage()}
        <div class="ship-spotlight-list">
          ${
            state.spotlights.length
              ? state.spotlights
                  .map((row) => {
                    const ship = shipById(row.ship_id);
                    const image = String(row.hero_image_url || ship?.hero_image_url || "").trim();
                    const status = row.publication_status === "published" ? "Published" : row.publication_status === "archived" ? "Archived" : "Draft";
                    return `
                      <article class="ship-spotlight-list-card">
                        <button type="button" class="ship-spotlight-list-main" onclick="ShipSpotlightAdmin.edit('${esc(row.id)}')">
                          <span class="ship-spotlight-list-thumb">${image ? `<img src="${esc(image)}" alt="">` : ""}</span>
                          <span>
                            <strong>${esc(ship?.name || row.newsletter_heading || "Ship Spotlight")}</strong>
                            <span class="admin-muted">${esc(lineName(ship) || "Cruise line")}</span>
                            <span class="admin-small">${esc(status)} · /ship?slug=${esc(row.public_slug || ship?.slug || "")}</span>
                          </span>
                        </button>
                        <div class="admin-actions-row">
                          <button type="button" class="admin-button secondary small" onclick="ShipSpotlightAdmin.edit('${esc(row.id)}')">Edit</button>
                          ${
                            row.publication_status === "published"
                              ? `<button type="button" class="admin-button secondary small" onclick="ShipSpotlightAdmin.openPublic('${esc(row.id)}')">View page</button>`
                              : ""
                          }
                        </div>
                      </article>`;
                  })
                  .join("")
              : `<div class="admin-card crm-empty-card"><p class="admin-muted">No Ship Spotlights yet. Create the first one from your Cruise Intelligence ship database.</p></div>`
          }
        </div>
      </div>`;
  }

  function availableShipOptions() {
    const used = new Set(
      state.spotlights.filter((row) => row.id !== state.draft?.id).map((row) => row.ship_id)
    );
    return state.ships
      .filter((ship) => !used.has(ship.id) || ship.id === state.draft?.ship_id)
      .map(
        (ship) =>
          `<option value="${esc(ship.id)}" ${
            ship.id === state.draft?.ship_id ? "selected" : ""
          }>${esc(lineName(ship) ? `${lineName(ship)} · ${ship.name}` : ship.name)}</option>`
      )
      .join("");
  }

  function statControls() {
    const defs = renderer()?.STAT_DEFS || {};
    const selected = new Set(state.draft?.stat_keys || []);
    const ship = shipById(state.draft?.ship_id);
    return Object.entries(defs)
      .map(([key, def]) => {
        const hasValue = ship && ship[key] !== null && ship[key] !== undefined && ship[key] !== "";
        return `
          <label class="ship-spotlight-stat-option${hasValue ? "" : " is-unavailable"}">
            <input type="checkbox" value="${esc(key)}" ${
              selected.has(key) ? "checked" : ""
            } onchange="ShipSpotlightAdmin.toggleStat('${esc(key)}', this.checked)" ${
              !hasValue ? "disabled" : ""
            }>
            <span>${esc(def.label)}</span>
          </label>`;
      })
      .join("");
  }

  function renderImagePicker() {
    if (!state.draft?.ship_id) return `<p class="admin-muted">Choose a ship to see its images.</p>`;
    if (!state.shipMedia.length) {
      return `<p class="admin-muted">No linked ship imagery was found. Add images in Marketing → Media Library, then reopen this Ship Spotlight.</p>`;
    }
    const supporting = new Set(state.draft.supporting_image_urls || []);
    return `
      <div class="ship-spotlight-media-grid">
        ${state.shipMedia
          .map((item) => {
            const isHero = item.url === state.draft.hero_image_url;
            const isSupporting = supporting.has(item.url);
            return `
              <div class="ship-spotlight-media-card${isHero ? " is-hero" : ""}">
                <img src="${esc(item.url)}" alt="${esc(item.alt || item.title || "Ship image")}" loading="lazy">
                <div class="ship-spotlight-media-meta">
                  <strong>${esc(item.title || "Ship image")}</strong>
                  <label><input type="radio" name="shipSpotlightHero" ${
                    isHero ? "checked" : ""
                  } onchange="ShipSpotlightAdmin.setHero('${esc(item.url)}')"> Hero</label>
                  <label><input type="checkbox" ${
                    isSupporting ? "checked" : ""
                  } onchange="ShipSpotlightAdmin.toggleSupporting('${esc(item.url)}', this.checked)"> Public gallery</label>
                </div>
              </div>`;
          })
          .join("")}
      </div>`;
  }

  function renderPreview() {
    if (!state.previewHtml) return "";
    return `
      <section class="ship-spotlight-preview-panel">
        <div class="admin-list-top">
          <div>
            <h4>Email preview</h4>
            <p class="admin-muted">This is a separate Mailchimp Code Block. It will not be inserted into the Newsletter specials block automatically.</p>
          </div>
        </div>
        <div class="ship-spotlight-preview-frame">${state.previewHtml}</div>
      </section>`;
  }

  function renderEditor() {
    const d = state.draft || freshDraft();
    const ship = shipById(d.ship_id);
    return `
      <div class="admin-card ship-spotlight-admin">
        <div class="admin-list-top">
          <div>
            <p class="admin-nav-eyebrow">Marketing</p>
            <h3>${d.id ? "Edit Ship Spotlight" : "Create Ship Spotlight"}</h3>
            <p class="admin-muted">The ship facts come from Cruise Intelligence. You only set the marketing treatment, imagery and editorial copy here.</p>
          </div>
          <button type="button" class="admin-button secondary" onclick="ShipSpotlightAdmin.back()">Back to Ship Spotlights</button>
        </div>

        ${renderMessage()}

        <div class="ship-spotlight-form-grid">
          <div class="admin-field ship-spotlight-field-wide">
            <label for="shipSpotlightShip">Ship <span class="admin-required">*</span></label>
            <select id="shipSpotlightShip" onchange="ShipSpotlightAdmin.changeShip(this.value)" ${
              d.id ? "disabled" : ""
            }>
              <option value="">Choose a ship…</option>
              ${availableShipOptions()}
            </select>
          </div>

          <div class="admin-field">
            <label for="shipSpotlightEyebrow">Newsletter label</label>
            <input id="shipSpotlightEyebrow" value="${esc(d.eyebrow)}" oninput="ShipSpotlightAdmin.setField('eyebrow', this.value)" placeholder="SHIP OF THE WEEK">
          </div>

          <div class="admin-field">
            <label for="shipSpotlightHeading">Heading</label>
            <input id="shipSpotlightHeading" value="${esc(d.newsletter_heading)}" oninput="ShipSpotlightAdmin.setField('newsletter_heading', this.value)" placeholder="${esc(ship?.name || "Ship name")}">
          </div>

          <div class="admin-field ship-spotlight-field-wide">
            <label for="shipSpotlightIntro">Short editorial introduction</label>
            <textarea id="shipSpotlightIntro" rows="4" oninput="ShipSpotlightAdmin.setField('editorial_intro', this.value)" placeholder="A short, engaging introduction to why this ship is worth knowing about.">${esc(d.editorial_intro)}</textarea>
          </div>

          <div class="ship-spotlight-field-wide">
            <label class="ship-spotlight-section-label">Why this ship stands out</label>
            <p class="admin-helper">Up to four short highlights. These appear in both the email teaser and full ship page.</p>
            <div class="ship-spotlight-highlights-form">
              ${[0, 1, 2, 3]
                .map(
                  (index) =>
                    `<input value="${esc(d.highlights[index] || "")}" oninput="ShipSpotlightAdmin.setHighlight(${index}, this.value)" placeholder="Highlight ${index + 1}">`
                )
                .join("")}
            </div>
          </div>

          <div class="ship-spotlight-field-wide">
            <label class="ship-spotlight-section-label">Newsletter statistics</label>
            <p class="admin-helper">Choose the strongest facts for the email. Empty data points are automatically unavailable.</p>
            <div class="ship-spotlight-stat-grid">${statControls()}</div>
          </div>

          <div class="admin-field">
            <label for="shipSpotlightStatus">Status</label>
            <select id="shipSpotlightStatus" onchange="ShipSpotlightAdmin.setField('publication_status', this.value)">
              <option value="draft" ${d.publication_status === "draft" ? "selected" : ""}>Draft</option>
              <option value="published" ${d.publication_status === "published" ? "selected" : ""}>Published</option>
              <option value="archived" ${d.publication_status === "archived" ? "selected" : ""}>Archived</option>
            </select>
          </div>

          <div class="admin-field">
            <label>Public page</label>
            <input value="${esc(d.public_slug ? `https://www.101cruise.com.au/ship?slug=${d.public_slug}` : "Choose a ship first")}" readonly>
          </div>

          <div class="ship-spotlight-field-wide">
            <div class="admin-list-top">
              <div>
                <label class="ship-spotlight-section-label">Ship imagery</label>
                <p class="admin-helper">Choose the hero image and optional gallery images. New ship images continue to be managed through Media Library so there is only one master copy.</p>
              </div>
              <button type="button" class="admin-button secondary small" onclick="ShipSpotlightAdmin.openMediaLibrary()">Open Media Library</button>
            </div>
            ${renderImagePicker()}
          </div>
        </div>

        <div class="ship-spotlight-actions">
          <button type="button" class="admin-button black" onclick="ShipSpotlightAdmin.save()" ${
            state.busy || !d.ship_id ? "disabled" : ""
          }>${state.busy ? "Saving…" : "Save Ship Spotlight"}</button>
          <button type="button" class="admin-button secondary" onclick="ShipSpotlightAdmin.preview()" ${
            state.busy || !d.ship_id ? "disabled" : ""
          }>Preview Email Block</button>
          <button type="button" class="admin-button secondary" onclick="ShipSpotlightAdmin.copyHtml()" ${
            state.busy || !d.ship_id ? "disabled" : ""
          }>Copy HTML</button>
          <button type="button" class="admin-button secondary" onclick="ShipSpotlightAdmin.downloadHtml()" ${
            state.busy || !d.ship_id ? "disabled" : ""
          }>Download HTML</button>
          ${
            d.id && d.publication_status === "published"
              ? `<button type="button" class="admin-button secondary" onclick="ShipSpotlightAdmin.openPublic('${esc(d.id)}')">View Public Page</button>`
              : ""
          }
        </div>

        ${renderPreview()}
      </div>`;
  }

  function render() {
    let root = document.getElementById(MOUNT_ID);
    if (!root) root = mount();
    if (!root) return;
    if (state.loading && !state.loaded) {
      root.innerHTML = `<div class="admin-card">${typeof global.brandLoadingPanel === "function" ? global.brandLoadingPanel("Loading Ship Spotlights…") : '<p class="admin-muted">Loading Ship Spotlights…</p>'}</div>`;
      return;
    }
    root.innerHTML = state.view === "edit" ? renderEditor() : renderList();
    if (typeof global.AdminHeight?.schedule === "function") global.AdminHeight.schedule();
  }

  async function open() {
    mount();
    injectNavItem();
    state.message = "";
    state.tone = "";
    state.view = "list";
    render();
    try {
      await loadData();
      render();
    } catch (error) {
      state.message = error.message || "Ship Spotlights could not be loaded.";
      state.tone = "error";
      render();
    }
  }

  async function createNew() {
    state.view = "edit";
    state.draft = freshDraft();
    state.shipMedia = [];
    state.previewHtml = "";
    state.hostedHtml = "";
    state.message = "";
    render();
  }

  async function edit(id) {
    const row = spotlightById(id);
    if (!row) return;
    state.view = "edit";
    state.draft = draftFromRow(row);
    state.previewHtml = "";
    state.hostedHtml = "";
    state.message = "";
    await loadShipMedia(row.ship_id);
    render();
  }

  function back() {
    state.view = "list";
    state.draft = null;
    state.previewHtml = "";
    state.hostedHtml = "";
    state.shipMedia = [];
    state.message = "";
    render();
  }

  function setField(key, value) {
    if (!state.draft) return;
    state.draft[key] = value;
    state.hostedHtml = "";
  }

  function setHighlight(index, value) {
    if (!state.draft) return;
    state.draft.highlights[index] = value;
    state.hostedHtml = "";
  }

  async function changeShip(shipId) {
    const ship = shipById(shipId);
    state.draft.ship_id = shipId || "";
    state.draft.newsletter_heading = ship?.name || "";
    state.draft.public_slug = ship?.slug || renderer()?.slugify(ship?.name || "") || "";
    state.draft.hero_image_url = ship?.hero_image_url || "";
    state.draft.supporting_image_urls = [];
    state.draft.stat_keys = [...(renderer()?.DEFAULT_STAT_KEYS || [])];
    state.previewHtml = "";
    state.hostedHtml = "";
    await loadShipMedia(shipId);
    render();
  }

  function toggleStat(key, checked) {
    if (!state.draft) return;
    const set = new Set(state.draft.stat_keys || []);
    if (checked) set.add(key);
    else set.delete(key);
    state.draft.stat_keys = [...set];
    state.hostedHtml = "";
    render();
  }

  function setHero(url) {
    if (!state.draft) return;
    state.draft.hero_image_url = url;
    state.hostedHtml = "";
    render();
  }

  function toggleSupporting(url, checked) {
    if (!state.draft) return;
    const set = new Set(state.draft.supporting_image_urls || []);
    if (checked) {
      if (set.size >= 6) {
        state.message = "Use up to six supporting images on the public ship page.";
        state.tone = "info";
      } else {
        set.add(url);
      }
    } else {
      set.delete(url);
    }
    state.draft.supporting_image_urls = [...set];
    render();
  }

  function payload() {
    const d = state.draft;
    return {
      ship_id: d.ship_id,
      eyebrow: String(d.eyebrow || "SHIP OF THE WEEK").trim() || "SHIP OF THE WEEK",
      newsletter_heading: String(d.newsletter_heading || "").trim() || null,
      editorial_intro: String(d.editorial_intro || "").trim() || null,
      highlights: (d.highlights || []).map((item) => String(item || "").trim()).filter(Boolean),
      stat_keys: Array.isArray(d.stat_keys) ? d.stat_keys : [],
      hero_image_url: String(d.hero_image_url || "").trim() || null,
      supporting_image_urls: Array.isArray(d.supporting_image_urls) ? d.supporting_image_urls : [],
      public_slug: String(d.public_slug || "").trim(),
      publication_status: d.publication_status || "draft",
      active: d.publication_status !== "archived"
    };
  }

  async function save(options = {}) {
    const db = client();
    const r = renderer();
    const ship = shipById(state.draft?.ship_id);
    if (!db || !r || !state.draft || !ship) throw new Error("Choose a ship first.");

    const problems = r.validate(state.draft, ship);
    if (problems.length) {
      state.message = problems.join(" ");
      state.tone = "error";
      render();
      return null;
    }

    state.busy = true;
    if (!options.quiet) {
      state.message = "Saving Ship Spotlight…";
      state.tone = "running";
      render();
    }

    try {
      const userId = await currentUserId();
      const body = {
        ...payload(),
        updated_at: new Date().toISOString(),
        updated_by: userId
      };
      let result;
      if (state.draft.id) {
        result = await db
          .from("ship_spotlights")
          .update(body)
          .eq("id", state.draft.id)
          .select("*")
          .single();
      } else {
        result = await db
          .from("ship_spotlights")
          .insert({ ...body, created_by: userId })
          .select("*")
          .single();
      }
      if (result.error) throw result.error;

      const row = result.data;
      const existingIndex = state.spotlights.findIndex((item) => item.id === row.id);
      if (existingIndex >= 0) state.spotlights[existingIndex] = row;
      else state.spotlights.unshift(row);
      state.draft = draftFromRow(row);
      state.message = "Ship Spotlight saved.";
      state.tone = "success";
      return row;
    } catch (error) {
      state.message = error.message || "Ship Spotlight could not be saved.";
      state.tone = "error";
      return null;
    } finally {
      state.busy = false;
      if (!options.skipRender) render();
    }
  }

  function buildEmail() {
    const r = renderer();
    const ship = shipById(state.draft?.ship_id);
    if (!r || !ship || !state.draft) return { ok: false, errors: ["Choose a ship first."] };
    return r.renderFragment(state.draft, ship);
  }

  function preview() {
    const result = buildEmail();
    if (!result.ok) {
      state.message = (result.errors || ["Preview could not be built."]).join(" ");
      state.tone = "error";
      state.previewHtml = "";
    } else {
      state.previewHtml = result.previewHtml;
      state.message = "Email block preview ready.";
      state.tone = "success";
    }
    render();
  }

  async function authHeaders() {
    if (typeof global.adminAuthHeaders === "function") {
      return global.adminAuthHeaders({ "Content-Type": "application/json" });
    }
    return { "Content-Type": "application/json" };
  }

  async function prepareHostedHtml(html, spotlightId) {
    const helper = global.NewsletterMailchimpAssets;
    if (!helper) throw new Error("Newsletter image preparation module is not available.");
    const urls = helper.collectSupabaseImageUrls(html);
    if (!urls.length) {
      const safety = helper.assertNoSupabaseStorageUrls(html);
      if (!safety.ok) throw new Error(safety.error);
      return { html, uploaded: 0, reused: 0 };
    }

    const mappings = [];
    let uploaded = 0;
    let reused = 0;
    for (let index = 0; index < urls.length; index += 1) {
      const url = urls[index];
      state.message = `Preparing Ship Spotlight image ${index + 1} of ${urls.length}…`;
      state.tone = "running";
      render();
      const response = await fetch(MAILCHIMP_ENDPOINT, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({
          spotlight_id: spotlightId,
          assets: [
            {
              source_url: url,
              asset_type: "hero",
              label: shipById(state.draft?.ship_id)?.name || "ship"
            }
          ]
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false || !data.mappings?.[0]?.mailchimp_file_url) {
        throw new Error(data.error || `Ship Spotlight image ${index + 1} could not be prepared.`);
      }
      mappings.push(data.mappings[0]);
      uploaded += Number(data.uploaded || 0);
      reused += Number(data.reused || 0);
    }

    const rewritten = helper.replaceImageUrls(html, mappings);
    const safety = helper.assertNoSupabaseStorageUrls(rewritten);
    if (!safety.ok) throw new Error(safety.error);
    return { html: rewritten, uploaded, reused };
  }

  async function copyHtml() {
    const helper = global.NewsletterMailchimpAssets;
    if (!helper) {
      state.message = "Newsletter copy/export tools are not available.";
      state.tone = "error";
      render();
      return;
    }

    if (state.hostedHtml) {
      const copied = await helper.copyHostedHtml(state.hostedHtml);
      state.message = copied.ok
        ? "Ship Spotlight HTML copied. Paste it into its own Mailchimp Code Block wherever you want it."
        : copied.error || "Could not copy HTML.";
      state.tone = copied.ok ? "success" : "info";
      render();
      return;
    }

    const result = buildEmail();
    if (!result.ok) {
      state.message = (result.errors || []).join(" ");
      state.tone = "error";
      render();
      return;
    }

    const saved = await save({ quiet: true, skipRender: true });
    if (!saved) {
      render();
      return;
    }

    state.busy = true;
    try {
      const prepared = await prepareHostedHtml(result.html, saved.id);
      state.hostedHtml = prepared.html;
      const copied = await helper.copyHostedHtml(prepared.html);
      const assetNote = prepared.uploaded
        ? ` ${prepared.uploaded} image${prepared.uploaded === 1 ? "" : "s"} uploaded to Mailchimp.`
        : prepared.reused
          ? " Existing Mailchimp image reused."
          : "";
      state.message = copied.ok
        ? `Ship Spotlight HTML copied.${assetNote} Paste it into its own Mailchimp Code Block wherever you want it.`
        : copied.error || "HTML is prepared. Click Copy HTML again.";
      state.tone = copied.ok ? "success" : "info";
    } catch (error) {
      state.message = error.message || "Ship Spotlight HTML could not be prepared.";
      state.tone = "error";
    } finally {
      state.busy = false;
      render();
    }
  }

  async function downloadHtml() {
    const result = buildEmail();
    if (!result.ok) {
      state.message = (result.errors || []).join(" ");
      state.tone = "error";
      render();
      return;
    }
    const saved = await save({ quiet: true, skipRender: true });
    if (!saved) {
      render();
      return;
    }

    state.busy = true;
    try {
      const prepared = state.hostedHtml
        ? { html: state.hostedHtml, uploaded: 0, reused: 0 }
        : await prepareHostedHtml(result.html, saved.id);
      state.hostedHtml = prepared.html;
      const blob = new Blob([prepared.html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.filename || "ship-spotlight.html";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      state.message = "Ship Spotlight HTML downloaded.";
      state.tone = "success";
    } catch (error) {
      state.message = error.message || "Ship Spotlight HTML could not be downloaded.";
      state.tone = "error";
    } finally {
      state.busy = false;
      render();
    }
  }

  function openPublic(id) {
    const row = spotlightById(id) || (state.draft?.id === id ? state.draft : null);
    const slug = row?.public_slug || shipById(row?.ship_id)?.slug || "";
    if (!slug) return;
    global.open(`https://www.101cruise.com.au/ship?slug=${encodeURIComponent(slug)}`, "_blank", "noopener");
  }

  function openMediaLibrary() {
    if (typeof global.setTab === "function") global.setTab("media-library");
  }

  function injectNavItem() {
    const group = document.querySelector('[data-admin-nav-group="marketing"]');
    const menu = group?.querySelector(".admin-nav-dropdown");
    if (!menu || document.getElementById(NAV_ID)) return;
    const button = document.createElement("button");
    button.type = "button";
    button.role = "menuitem";
    button.id = NAV_ID;
    button.className = "admin-nav-leaf";
    button.innerHTML = "<span>Ship Spotlights</span>";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      open();
    });
    const newsletterButton = Array.from(menu.querySelectorAll(".admin-nav-leaf")).find((el) =>
      /newsletter/i.test(el.textContent || "")
    );
    if (newsletterButton?.nextSibling) menu.insertBefore(button, newsletterButton.nextSibling);
    else menu.appendChild(button);
  }

  const observer = new MutationObserver(() => injectNavItem());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectNavItem, { once: true });
  } else {
    injectNavItem();
  }

  global.ShipSpotlightAdmin = {
    open,
    render,
    createNew,
    edit,
    back,
    setField,
    setHighlight,
    changeShip,
    toggleStat,
    setHero,
    toggleSupporting,
    save,
    preview,
    copyHtml,
    downloadHtml,
    openPublic,
    openMediaLibrary,
    ensureLoaded: loadData,
    injectNavItem
  };
})(window);
