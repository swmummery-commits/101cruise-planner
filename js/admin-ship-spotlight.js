/* Ship Spotlight / Ship of the Week marketing workspace.
 * Deliberately separate from the cruise-specials newsletter composer.
 * Generates a standalone Mailchimp-ready HTML block which can be copied and
 * pasted into a normal newsletter code block wherever the editor chooses.
 */
(function (global) {
  "use strict";

  const PUBLIC_BASE = "https://101cruise.com.au/ships/";
  const EMAIL_ASSET_ENDPOINT = "/.netlify/functions/ship-spotlight-mailchimp-assets";
  const STAT_OPTIONS = [
    ["year_built", "Launched"],
    ["year_refurbished", "Refurbished"],
    ["passenger_capacity", "Guests"],
    ["crew_count", "Crew"],
    ["gross_tonnage", "Tonnage"],
    ["length_metres", "Length"],
    ["beam_metres", "Beam"],
    ["deck_count", "Decks"],
    ["stateroom_count", "Staterooms"],
    ["cruising_speed_knots", "Cruising speed"]
  ];
  const DEFAULT_STATS = ["year_built", "passenger_capacity", "crew_count", "gross_tonnage", "length_metres", "deck_count"];

  let loaded = false;
  let busy = false;
  let message = "";
  let messageTone = "";
  let ships = [];
  let lines = [];
  let spotlights = [];
  let media = [];
  let research = [];
  let selectedShipId = "";
  let draft = null;
  let overlay = null;
  let previewOpen = false;
  let hostedHtmlCache = "";

  const esc = (value) => String(value == null ? "" : value)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

  function slugify(value) {
    return String(value || "")
      .normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "ship";
  }

  function client() {
    if (!global.supabaseClient) throw new Error("Supabase client is unavailable. Reload Admin and try again.");
    return global.supabaseClient;
  }

  function shipById(id) { return ships.find((row) => row.id === id) || null; }
  function lineById(id) { return lines.find((row) => row.id === id) || null; }
  function currentShip() { return shipById(selectedShipId); }
  function currentLine() { const ship = currentShip(); return ship ? lineById(ship.cruise_line_id) : null; }
  function shipMedia(id) {
    return media.filter((row) => row.ship_id === id && row.is_active !== false && row.public_url)
      .sort((a, b) => Number(Boolean(b.is_default)) - Number(Boolean(a.is_default)) || String(a.title || "").localeCompare(String(b.title || "")));
  }
  function shipResearch(id) {
    return research.find((row) => row.entity_type === "ship" && row.entity_id === id && ["published", "reviewed"].includes(row.content_status))
      || research.find((row) => row.entity_type === "ship" && row.entity_id === id)
      || null;
  }

  function firstUsefulStrings(value, out = []) {
    if (out.length >= 8 || value == null) return out;
    if (typeof value === "string") {
      const clean = value.replace(/\s+/g, " ").trim();
      if (clean.length >= 24 && clean.length <= 220 && !out.includes(clean)) out.push(clean);
      return out;
    }
    if (Array.isArray(value)) {
      for (const item of value) firstUsefulStrings(item, out);
      return out;
    }
    if (typeof value === "object") {
      for (const item of Object.values(value)) firstUsefulStrings(item, out);
    }
    return out;
  }

  function defaultHighlights(ship) {
    const row = shipResearch(ship.id);
    const fromResearch = firstUsefulStrings(row?.content_json || {}).slice(0, 3);
    if (fromResearch.length) return fromResearch;
    const facilities = firstUsefulStrings(ship.facilities || {}).slice(0, 3);
    return facilities.length ? facilities : ["Add a distinctive feature or experience aboard this ship.", "Add a second reason this ship is worth considering.", "Add one more memorable onboard highlight."];
  }

  function freshDraft(ship) {
    const existing = spotlights.find((row) => row.ship_id === ship.id);
    const researchRow = shipResearch(ship.id);
    const images = shipMedia(ship.id);
    const gallery = Array.isArray(ship.image_gallery) ? ship.image_gallery : [];
    const hero = existing?.hero_image_url || ship.hero_image_url || images.find((row) => row.is_default)?.public_url || images[0]?.public_url || gallery[0] || "";
    const support = existing?.supporting_image_urls?.length
      ? existing.supporting_image_urls
      : images.map((row) => row.public_url).filter((url) => url && url !== hero).slice(0, 2);
    return {
      id: existing?.id || null,
      ship_id: ship.id,
      eyebrow: existing?.eyebrow || "SHIP OF THE WEEK",
      newsletter_heading: existing?.newsletter_heading || ship.name,
      editorial_intro: existing?.editorial_intro || researchRow?.summary_text || "",
      highlights: Array.isArray(existing?.highlights) && existing.highlights.length ? existing.highlights.slice(0, 5) : defaultHighlights(ship),
      stat_keys: Array.isArray(existing?.stat_keys) && existing.stat_keys.length ? existing.stat_keys : DEFAULT_STATS.slice(),
      hero_image_url: hero,
      supporting_image_urls: support,
      public_slug: existing?.public_slug || ship.slug || slugify(ship.name),
      publication_status: existing?.publication_status || "draft",
      active: existing?.active !== false
    };
  }

  async function ensureLoaded(force = false) {
    if (loaded && !force) return;
    busy = true; message = "Loading Ship Spotlights…"; messageTone = ""; render();
    const db = client();
    const [shipRes, lineRes, spotlightRes, mediaRes, researchRes] = await Promise.all([
      db.from("ci_cruise_ships").select("id,cruise_line_id,name,slug,status,ship_class,year_built,year_refurbished,passenger_capacity,crew_count,deck_count,stateroom_count,gross_tonnage,length_metres,beam_metres,cruising_speed_knots,facilities,hero_image_url,image_gallery,active").eq("active", true).order("name"),
      db.from("ci_cruise_lines").select("id,name,slug,logo_url,active,sold_by_101cruise").order("name"),
      db.from("ship_spotlights").select("*").order("updated_at", { ascending: false }),
      db.from("media_library").select("id,title,alt_text,public_url,ship_id,is_default,is_active,media_type").eq("media_type", "ship").eq("is_active", true),
      db.from("research_content").select("id,entity_type,entity_id,content_status,content_json,summary_text,pauls_tip,canonical_slug").eq("entity_type", "ship")
    ]);
    const failed = [shipRes, lineRes, spotlightRes, mediaRes, researchRes].find((r) => r.error);
    if (failed) throw failed.error;
    ships = shipRes.data || []; lines = lineRes.data || []; spotlights = spotlightRes.data || [];
    media = mediaRes.data || []; research = researchRes.data || [];
    loaded = true; busy = false; message = ""; render();
  }

  function capture() {
    if (!draft || !overlay) return;
    const value = (id) => overlay.querySelector(`#${id}`)?.value || "";
    draft.eyebrow = value("ssEyebrow");
    draft.newsletter_heading = value("ssHeading");
    draft.editorial_intro = value("ssIntro");
    draft.public_slug = slugify(value("ssSlug"));
    draft.publication_status = overlay.querySelector("#ssPublished")?.checked ? "published" : "draft";
    draft.highlights = [0,1,2,3,4].map((i) => value(`ssHighlight${i}`)).map((v) => v.trim()).filter(Boolean);
    draft.stat_keys = [...overlay.querySelectorAll('[data-ss-stat]:checked')].map((el) => el.value);
    draft.hero_image_url = value("ssHero");
    draft.supporting_image_urls = [...overlay.querySelectorAll('[data-ss-support]:checked')].map((el) => el.value).slice(0, 2);
  }

  async function selectShip(id) {
    capture(); selectedShipId = id || ""; hostedHtmlCache = ""; previewOpen = false;
    draft = selectedShipId ? freshDraft(currentShip()) : null;
    message = ""; messageTone = ""; render();
  }

  function statValue(ship, key) {
    const raw = ship?.[key];
    if (raw == null || raw === "") return "";
    if (key === "gross_tonnage") return `${Number(raw).toLocaleString("en-AU")} GT`;
    if (key === "length_metres" || key === "beam_metres") return `${Number(raw).toLocaleString("en-AU", { maximumFractionDigits: 1 })} m`;
    if (key === "cruising_speed_knots") return `${Number(raw).toLocaleString("en-AU", { maximumFractionDigits: 1 })} kn`;
    if (["passenger_capacity", "crew_count", "deck_count", "stateroom_count", "year_built", "year_refurbished"].includes(key)) return Number(raw).toLocaleString("en-AU", { maximumFractionDigits: 0 });
    return String(raw);
  }

  function statsForDraft(ship) {
    return (draft?.stat_keys || []).map((key) => {
      const option = STAT_OPTIONS.find(([k]) => k === key);
      const value = statValue(ship, key);
      return option && value ? { key, label: option[1], value } : null;
    }).filter(Boolean);
  }

  function publicUrl() { return draft?.public_slug ? `${PUBLIC_BASE}${encodeURIComponent(draft.public_slug)}` : ""; }

  function emailHtml() {
    capture();
    const ship = currentShip(); const line = currentLine();
    if (!ship || !draft) return "";
    const stats = statsForDraft(ship);
    const statCells = stats.map((item) => `<td width="33.33%" valign="top" style="padding:10px 6px;text-align:center;border-top:1px solid #e5e7eb;"><div style="font-family:Arial,sans-serif;font-size:11px;line-height:15px;color:#687076;text-transform:uppercase;letter-spacing:.6px;">${esc(item.label)}</div><div style="font-family:Arial,sans-serif;font-size:18px;line-height:24px;color:#17202a;font-weight:700;">${esc(item.value)}</div></td>`);
    const statRows = [];
    for (let i = 0; i < statCells.length; i += 3) {
      const cells = statCells.slice(i, i + 3);
      while (cells.length < 3) cells.push('<td width="33.33%"></td>');
      statRows.push(`<tr>${cells.join("")}</tr>`);
    }
    const highlights = (draft.highlights || []).slice(0, 3).map((text) => `<tr><td width="22" valign="top" style="padding:5px 0;color:#1f8a70;font-family:Arial,sans-serif;font-size:18px;line-height:22px;">•</td><td style="padding:5px 0;font-family:Arial,sans-serif;font-size:15px;line-height:22px;color:#303840;">${esc(text)}</td></tr>`).join("");
    const supports = (draft.supporting_image_urls || []).slice(0, 2);
    const supportHtml = supports.length ? `<tr><td style="padding:0 28px 24px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>${supports.map((url) => `<td width="50%" style="padding:${supports.length > 1 ? "0 4px" : "0"};"><img src="${esc(url)}" alt="${esc(ship.name)}" width="280" style="display:block;width:100%;height:auto;border:0;border-radius:8px;"></td>`).join("")}</tr></table></td></tr>` : "";
    return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f7f7f7;"><tr><td align="center" style="padding:20px 12px;"><table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:640px;background:#ffffff;border-radius:12px;overflow:hidden;"><tr><td style="padding:26px 28px 14px;text-align:center;"><div style="font-family:Arial,sans-serif;font-size:12px;line-height:16px;color:#1f8a70;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">${esc(draft.eyebrow)}</div><div style="font-family:Arial,sans-serif;font-size:30px;line-height:36px;color:#17202a;font-weight:700;margin-top:5px;">${esc(draft.newsletter_heading || ship.name)}</div><div style="font-family:Arial,sans-serif;font-size:14px;line-height:20px;color:#687076;margin-top:4px;">${esc(line?.name || "")}</div></td></tr><tr><td><img src="${esc(draft.hero_image_url)}" alt="${esc(ship.name)}" width="640" style="display:block;width:100%;height:auto;border:0;"></td></tr><tr><td style="padding:18px 22px 8px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${statRows.join("")}</table></td></tr>${draft.editorial_intro ? `<tr><td style="padding:10px 28px 4px;font-family:Arial,sans-serif;font-size:16px;line-height:24px;color:#303840;">${esc(draft.editorial_intro)}</td></tr>` : ""}${highlights ? `<tr><td style="padding:10px 28px 18px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${highlights}</table></td></tr>` : ""}${supportHtml}<tr><td align="center" style="padding:2px 28px 30px;"><a href="${esc(publicUrl())}" style="display:inline-block;background:#17202a;color:#ffffff;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:700;line-height:18px;padding:13px 22px;border-radius:6px;">EXPLORE ${esc(ship.name.toUpperCase())}</a></td></tr></table></td></tr></table>`;
  }

  async function save({ quiet = false } = {}) {
    capture(); const ship = currentShip(); if (!ship || !draft) return false;
    if (!draft.hero_image_url) { message = "Choose a hero image before saving."; messageTone = "error"; render(); return false; }
    if (!draft.stat_keys.length) { message = "Choose at least one ship statistic."; messageTone = "error"; render(); return false; }
    busy = true; message = "Saving Ship Spotlight…"; messageTone = ""; render();
    const user = (await client().auth.getUser()).data?.user || null;
    const payload = {
      ship_id: ship.id, eyebrow: draft.eyebrow || "SHIP OF THE WEEK",
      newsletter_heading: draft.newsletter_heading || ship.name,
      editorial_intro: draft.editorial_intro || null, highlights: draft.highlights || [],
      stat_keys: draft.stat_keys || DEFAULT_STATS, hero_image_url: draft.hero_image_url,
      supporting_image_urls: draft.supporting_image_urls || [], public_slug: slugify(draft.public_slug || ship.slug || ship.name),
      publication_status: draft.publication_status || "draft", active: true,
      updated_by: user?.id || null, ...(draft.id ? {} : { created_by: user?.id || null })
    };
    const result = await client().from("ship_spotlights").upsert(payload, { onConflict: "ship_id" }).select("*").single();
    if (result.error) { busy = false; message = result.error.message; messageTone = "error"; render(); return false; }
    draft = { ...draft, ...result.data }; spotlights = spotlights.filter((r) => r.ship_id !== ship.id).concat(result.data);
    busy = false; if (!quiet) { message = "Ship Spotlight saved."; messageTone = "success"; } render(); return true;
  }

  async function prepareHostedHtml() {
    const saved = await save({ quiet: true }); if (!saved) return "";
    const rawHtml = emailHtml();
    const urls = [...new Set([draft.hero_image_url, ...(draft.supporting_image_urls || [])].filter(Boolean))];
    if (!urls.length) return rawHtml;
    let out = rawHtml;
    for (let i = 0; i < urls.length; i++) {
      message = `Preparing Ship Spotlight images ${i + 1} of ${urls.length}…`; messageTone = ""; busy = true; render();
      const headers = typeof global.adminAuthHeaders === "function" ? await global.adminAuthHeaders({ "Content-Type": "application/json" }) : { "Content-Type": "application/json" };
      const response = await fetch(EMAIL_ASSET_ENDPOINT, { method: "POST", headers, body: JSON.stringify({ spotlight_id: draft.id, asset_index: i + 1, asset_total: urls.length, assets: [{ source_url: urls[i], asset_type: i === 0 ? "hero" : "other", label: currentShip()?.name || "ship" }] }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false || !data.mappings?.[0]?.mailchimp_file_url) throw new Error(data.error || `Could not prepare Ship Spotlight image ${i + 1}.`);
      out = out.split(urls[i]).join(data.mappings[0].mailchimp_file_url);
    }
    return out;
  }

  async function copyNewsletterBlock() {
    if (busy) return;
    try {
      hostedHtmlCache = await prepareHostedHtml();
      const copier = global.NewsletterMailchimpAssets?.copyHostedHtml;
      if (copier) {
        const result = await copier(hostedHtmlCache);
        if (!result.ok) {
          if (result.code === "clipboard_blocked") { message = "The block is ready. Click Copy Newsletter Block again and it will copy immediately."; messageTone = "success"; busy = false; render(); return; }
          throw new Error(result.error || "Could not copy the newsletter block.");
        }
      } else {
        await navigator.clipboard.writeText(hostedHtmlCache);
      }
      busy = false; message = "Newsletter block copied. Paste it into a normal newsletter code block wherever you want it."; messageTone = "success"; render();
    } catch (error) { busy = false; message = error.message || "Could not prepare the newsletter block."; messageTone = "error"; render(); }
  }

  async function copyAgainIfReady() {
    if (!hostedHtmlCache) return copyNewsletterBlock();
    try {
      const result = global.NewsletterMailchimpAssets?.copyHostedHtml ? await global.NewsletterMailchimpAssets.copyHostedHtml(hostedHtmlCache) : (await navigator.clipboard.writeText(hostedHtmlCache), { ok: true });
      if (!result.ok) throw new Error(result.error || "Could not copy HTML.");
      message = "Newsletter block copied. Paste it into a normal newsletter code block wherever you want it."; messageTone = "success"; render();
    } catch (error) { message = error.message; messageTone = "error"; render(); }
  }

  function openPreview() { capture(); previewOpen = true; render(); }
  function closePreview() { previewOpen = false; render(); }
  function useMediaLibrary() { close(); if (typeof global.setActiveTab === "function") global.setActiveTab("media-library"); }

  function renderPreview() {
    if (!previewOpen || !draft) return "";
    return `<div class="ss-preview-backdrop" onclick="if(event.target===this) ShipSpotlightAdmin.closePreview()"><div class="ss-preview-modal"><div class="ss-preview-head"><strong>Newsletter block preview</strong><button class="admin-button secondary small" onclick="ShipSpotlightAdmin.closePreview()">Close</button></div><div class="ss-preview-canvas">${emailHtml()}</div></div></div>`;
  }

  function renderForm() {
    const ship = currentShip(); if (!ship || !draft) return `<div class="ss-empty"><h3>Create a Ship Spotlight</h3><p>Select a ship above. Its existing database facts and images will be loaded automatically.</p></div>`;
    const line = currentLine(); const images = shipMedia(ship.id);
    const allImageUrls = [...new Set([ship.hero_image_url, ...(Array.isArray(ship.image_gallery) ? ship.image_gallery : []), ...images.map((m) => m.public_url), draft.hero_image_url].filter(Boolean))];
    const stats = STAT_OPTIONS.map(([key,label]) => `<label class="ss-check"><input type="checkbox" data-ss-stat value="${esc(key)}" ${(draft.stat_keys || []).includes(key) ? "checked" : ""}> <span>${esc(label)}${statValue(ship,key) ? ` <small>${esc(statValue(ship,key))}</small>` : ""}</span></label>`).join("");
    const heroOptions = allImageUrls.map((url, i) => `<option value="${esc(url)}" ${url === draft.hero_image_url ? "selected" : ""}>${esc(images.find((m) => m.public_url === url)?.title || (url === ship.hero_image_url ? "Ship hero image" : `Ship image ${i+1}`))}</option>`).join("");
    const supports = allImageUrls.filter((url) => url !== draft.hero_image_url).slice(0, 12).map((url, i) => `<label class="ss-image-choice"><input type="checkbox" data-ss-support value="${esc(url)}" ${(draft.supporting_image_urls || []).includes(url) ? "checked" : ""}><img src="${esc(url)}" alt=""><span>${esc(images.find((m) => m.public_url === url)?.title || `Image ${i+1}`)}</span></label>`).join("");
    const highlights = [0,1,2,3,4].map((i) => `<div class="admin-field"><label>Highlight ${i+1}${i>2 ? " (optional)" : ""}</label><input id="ssHighlight${i}" value="${esc(draft.highlights?.[i] || "")}" placeholder="Interesting feature, venue or experience"></div>`).join("");
    return `<div class="ss-form"><div class="ss-identity"><div>${draft.hero_image_url ? `<img src="${esc(draft.hero_image_url)}" alt="">` : ""}</div><div><p class="admin-nav-eyebrow">${esc(line?.name || "Cruise line")}</p><h2>${esc(ship.name)}</h2><p class="admin-muted">${esc([ship.ship_class, ship.year_built ? `Built ${ship.year_built}` : ""].filter(Boolean).join(" · "))}</p></div></div>
      <section><h3>Newsletter presentation</h3><div class="ss-grid two"><div class="admin-field"><label>Eyebrow</label><input id="ssEyebrow" value="${esc(draft.eyebrow)}"></div><div class="admin-field"><label>Heading</label><input id="ssHeading" value="${esc(draft.newsletter_heading)}"></div></div><div class="admin-field"><label>Short introduction</label><textarea id="ssIntro" rows="4">${esc(draft.editorial_intro)}</textarea></div><div class="ss-grid two">${highlights}</div></section>
      <section><h3>Interesting ship statistics</h3><p class="admin-muted">Choose the facts you want shown in the newsletter block.</p><div class="ss-stat-grid">${stats}</div></section>
      <section><div class="ss-section-head"><div><h3>Images</h3><p class="admin-muted">Uses the existing ship/media library. Up to two supporting images are included in the email.</p></div><button class="admin-button secondary small" onclick="ShipSpotlightAdmin.useMediaLibrary()">Open Media Library</button></div><div class="admin-field"><label>Hero image</label><select id="ssHero" onchange="ShipSpotlightAdmin.capture(); ShipSpotlightAdmin.render()"><option value="">Select image</option>${heroOptions}</select></div><div class="ss-image-grid">${supports || '<p class="admin-muted">No additional ship images are currently in the media library.</p>'}</div></section>
      <section><h3>Public ship page</h3><div class="ss-grid two"><div class="admin-field"><label>Public slug</label><input id="ssSlug" value="${esc(draft.public_slug)}"></div><label class="ss-publish"><input id="ssPublished" type="checkbox" ${draft.publication_status === "published" ? "checked" : ""}> Publish this Ship Spotlight page</label></div><div class="admin-helper">${esc(publicUrl())}</div></section>
      <div class="ss-actions"><button class="admin-button secondary" onclick="ShipSpotlightAdmin.openPreview()">Preview Newsletter Block</button><button class="admin-button secondary" onclick="ShipSpotlightAdmin.save()" ${busy ? "disabled" : ""}>Save Spotlight</button><button class="admin-button black" onclick="ShipSpotlightAdmin.${hostedHtmlCache ? "copyAgainIfReady" : "copyNewsletterBlock"}()" ${busy ? "disabled" : ""}>${busy ? "Preparing…" : "Copy Newsletter Block"}</button></div>
    </div>`;
  }

  function styles() {
    if (document.getElementById("shipSpotlightStyles")) return;
    const el = document.createElement("style"); el.id = "shipSpotlightStyles";
    el.textContent = `.ss-nav-btn{display:block;width:100%;border:0;background:transparent;text-align:left;padding:9px 14px 9px 28px;font:inherit;color:inherit;cursor:pointer}.ss-nav-btn:hover{background:rgba(0,0,0,.05)}.ss-overlay{position:fixed;inset:0;z-index:9998;background:#f4f5f6;overflow:auto}.ss-shell{max-width:1180px;margin:0 auto;padding:22px}.ss-top{display:flex;gap:16px;justify-content:space-between;align-items:flex-start;margin-bottom:16px}.ss-top h1{margin:2px 0 5px}.ss-top-actions{display:flex;gap:8px;align-items:center}.ss-card{background:#fff;border:1px solid #e3e6e8;border-radius:12px;padding:20px;box-shadow:0 8px 28px rgba(20,30,40,.05)}.ss-selector{display:flex;gap:12px;align-items:end;margin-bottom:16px}.ss-selector .admin-field{flex:1;margin:0}.ss-form section{padding:20px 0;border-top:1px solid #e8ebed}.ss-form section:first-of-type{border-top:0}.ss-form h3{margin:0 0 12px}.ss-grid{display:grid;gap:12px}.ss-grid.two{grid-template-columns:repeat(2,minmax(0,1fr))}.ss-identity{display:grid;grid-template-columns:150px 1fr;gap:18px;align-items:center;padding-bottom:20px}.ss-identity img{width:150px;height:95px;object-fit:cover;border-radius:9px}.ss-identity h2{margin:0 0 5px}.ss-stat-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.ss-check{display:flex;gap:8px;padding:10px;border:1px solid #dfe3e6;border-radius:8px}.ss-check small{display:block;color:#6d757d;margin-top:2px}.ss-section-head{display:flex;justify-content:space-between;gap:12px;align-items:start}.ss-image-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.ss-image-choice{position:relative;border:1px solid #dfe3e6;border-radius:8px;overflow:hidden;padding-bottom:7px}.ss-image-choice input{position:absolute;top:8px;left:8px;z-index:2}.ss-image-choice img{display:block;width:100%;aspect-ratio:16/10;object-fit:cover}.ss-image-choice span{display:block;font-size:11px;padding:5px 7px 0}.ss-publish{display:flex;align-items:center;gap:8px;padding-top:27px}.ss-actions{display:flex;justify-content:flex-end;gap:8px;padding-top:18px}.ss-message{margin:0 0 14px;padding:10px 12px;border-radius:8px;background:#eef2f4}.ss-message.success{background:#e9f7ef;color:#17633f}.ss-message.error{background:#fff0f0;color:#9a2525}.ss-preview-backdrop{position:fixed;inset:0;z-index:9999;background:rgba(20,25,30,.75);overflow:auto;padding:30px}.ss-preview-modal{max-width:760px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden}.ss-preview-head{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid #e4e7e9}.ss-preview-canvas{background:#f7f7f7;padding:18px}@media(max-width:760px){.ss-grid.two,.ss-stat-grid{grid-template-columns:1fr}.ss-image-grid{grid-template-columns:repeat(2,1fr)}.ss-top{display:block}.ss-top-actions{margin-top:10px}.ss-identity{grid-template-columns:1fr}.ss-selector{display:block}.ss-selector .admin-field{margin-bottom:8px}}`;
    document.head.appendChild(el);
  }

  function render() {
    if (!overlay) return;
    capture();
    const optionsByLine = lines.filter((l) => l.active !== false).map((line) => {
      const lineShips = ships.filter((s) => s.cruise_line_id === line.id).sort((a,b) => a.name.localeCompare(b.name));
      if (!lineShips.length) return "";
      return `<optgroup label="${esc(line.name)}">${lineShips.map((ship) => `<option value="${esc(ship.id)}" ${ship.id === selectedShipId ? "selected" : ""}>${esc(ship.name)}${spotlights.some((sp) => sp.ship_id === ship.id) ? " · Spotlight saved" : ""}</option>`).join("")}</optgroup>`;
    }).join("");
    overlay.innerHTML = `<div class="ss-shell"><div class="ss-top"><div><p class="admin-nav-eyebrow">Marketing</p><h1>Ship Spotlights</h1><p class="admin-muted">Create Ship of the Week content independently, then copy its standalone HTML into a normal newsletter code block wherever you want it.</p></div><div class="ss-top-actions"><button class="admin-button secondary" onclick="ShipSpotlightAdmin.ensureLoaded(true)" ${busy ? "disabled" : ""}>Refresh</button><button class="admin-button secondary" onclick="ShipSpotlightAdmin.close()">Close</button></div></div>${message ? `<div class="ss-message ${messageTone}">${esc(message)}</div>` : ""}<div class="ss-card"><div class="ss-selector"><div class="admin-field"><label>Ship</label><select onchange="ShipSpotlightAdmin.selectShip(this.value)" ${busy ? "disabled" : ""}><option value="">Select a ship</option>${optionsByLine}</select></div>${draft?.id ? `<div class="admin-small">Saved spotlight · ${esc(draft.publication_status || "draft")}</div>` : ""}</div>${busy && !loaded ? '<p class="admin-muted">Loading ship database…</p>' : renderForm()}</div></div>${renderPreview()}`;
  }

  async function open() {
    styles();
    if (!overlay) { overlay = document.createElement("div"); overlay.className = "ss-overlay"; overlay.id = "shipSpotlightOverlay"; document.body.appendChild(overlay); }
    overlay.hidden = false; render();
    try { await ensureLoaded(); } catch (error) { busy = false; message = error.message || "Could not load Ship Spotlights."; messageTone = "error"; render(); }
  }
  function close() { if (overlay) overlay.hidden = true; }

  function injectNav() {
    const group = document.querySelector('[data-admin-nav-group="marketing"]');
    if (!group || group.querySelector('[data-ship-spotlight-nav]')) return;
    const btn = document.createElement("button"); btn.type = "button"; btn.className = "ss-nav-btn"; btn.dataset.shipSpotlightNav = "true"; btn.textContent = "Ship Spotlight"; btn.addEventListener("click", open);
    const container = group.querySelector(".admin-nav-children,.admin-nav-items,.admin-nav-submenu") || group;
    container.appendChild(btn);
  }

  styles(); injectNav();
  new MutationObserver(injectNav).observe(document.documentElement, { childList: true, subtree: true });

  global.ShipSpotlightAdmin = { open, close, ensureLoaded, selectShip, render, capture, save, openPreview, closePreview, copyNewsletterBlock, copyAgainIfReady, useMediaLibrary, emailHtml };
})(window);