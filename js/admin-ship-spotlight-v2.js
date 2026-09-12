/* Ship Spotlight / Ship of the Week marketing workspace.
 * Standalone Mailchimp-ready block, deliberately separate from cruise specials.
 */
(function (global) {
  "use strict";

  const PUBLIC_BASE = "https://101cruise.com.au/ships/";
  const EMAIL_ASSET_ENDPOINT = "/.netlify/functions/ship-spotlight-mailchimp-assets";
  const MAX_WIDTH = 600;
  const PAGE_BG = "#F7F7F7";
  const BRAND_GREEN = "#8DD9BF";
  const BRAND_DARK_GREEN = "#245C4E";
  const BODY = "#111111";
  const MUTED = "#545454";
  const DIVIDER = "#E8E8E8";

  const TECHNICAL_STATS = [
    { key: "passenger_capacity", label: "Guests", icon: "●●" },
    { key: "stateroom_count", label: "Staterooms", icon: "▤" },
    { key: "crew_count", label: "Crew", icon: "●" },
    { key: "year_built", label: "Built", icon: "▣" },
    { key: "year_refurbished", label: "Refurbished", icon: "↻" },
    { key: "gross_tonnage", label: "Gross Tonnage", icon: "◆" },
    { key: "length_metres", label: "Length", icon: "↔" },
    { key: "beam_metres", label: "Beam", icon: "⇆" },
    { key: "cruising_speed_knots", label: "Cruising Speed", icon: "≫" },
    { key: "deck_count", label: "Decks", icon: "≡" }
  ];

  const ONBOARD_STATS = [
    { key: "restaurants", label: "Dining Options", icon: "⌘" },
    { key: "bars", label: "Bars", icon: "◇" },
    { key: "pools", label: "Pools", icon: "≈" },
    { key: "hot_tubs", label: "Hot Tubs", icon: "♨" },
    { key: "specialty_dining", label: "Specialty Dining", icon: "◈" }
  ];

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

  function meaningfulNumber(value) {
    if (value == null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function formatStatValue(ship, key) {
    const raw = ship?.[key];
    if (raw == null || raw === "") return "";
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return "";
    if (key === "year_built" || key === "year_refurbished") return String(Math.trunc(n));
    if (key === "gross_tonnage") return `${Math.round(n).toLocaleString("en-AU")} GT`;
    if (key === "length_metres" || key === "beam_metres") return `${n.toLocaleString("en-AU", { maximumFractionDigits: 1 })} m`;
    if (key === "cruising_speed_knots") return `${n.toLocaleString("en-AU", { maximumFractionDigits: 1 })} knots`;
    return Math.round(n).toLocaleString("en-AU");
  }

  function technicalStats(ship) {
    return TECHNICAL_STATS.map((item) => {
      const value = formatStatValue(ship, item.key);
      return value ? { ...item, value } : null;
    }).filter(Boolean);
  }

  function onboardStats(ship) {
    const facilities = ship?.facilities && typeof ship.facilities === "object" ? ship.facilities : {};
    return ONBOARD_STATS.map((item) => {
      const value = meaningfulNumber(facilities[item.key]);
      return value == null ? null : { ...item, value: Math.round(value).toLocaleString("en-AU") };
    }).filter(Boolean);
  }

  function featureList(value) {
    const source = Array.isArray(value) ? value : value ? [value] : [];
    const out = [];
    for (const item of source) {
      String(item || "")
        .split(/\s*,\s*|\s+and\s+/i)
        .map((part) => part.replace(/^and\s+/i, "").replace(/[.;]+$/, "").trim())
        .filter(Boolean)
        .forEach((part) => { if (!out.includes(part)) out.push(part); });
    }
    return out;
  }

  function exclusiveAreas(ship) { return featureList(ship?.facilities?.exclusive_areas); }
  function specialtyFeatures(ship) { return featureList(ship?.facilities?.specialty_features); }

  function freshDraft(ship) {
    const existing = spotlights.find((row) => row.ship_id === ship.id);
    const researchRow = shipResearch(ship.id);
    const images = shipMedia(ship.id);
    const gallery = Array.isArray(ship.image_gallery) ? ship.image_gallery : [];
    const hero = existing?.hero_image_url || ship.hero_image_url || images.find((row) => row.is_default)?.public_url || images[0]?.public_url || gallery[0] || "";
    return {
      id: existing?.id || null,
      ship_id: ship.id,
      eyebrow: existing?.eyebrow || "SHIP SPOTLIGHT",
      newsletter_heading: existing?.newsletter_heading || ship.name,
      editorial_intro: existing?.editorial_intro || researchRow?.summary_text || "",
      stat_keys: technicalStats(ship).map((item) => item.key),
      hero_image_url: hero,
      supporting_image_urls: Array.isArray(existing?.supporting_image_urls) ? existing.supporting_image_urls : [],
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
    if (selectedShipId) {
      const ship = shipById(selectedShipId);
      if (ship) draft = freshDraft(ship);
    }
    loaded = true; busy = false; message = ""; render();
  }

  function capture() {
    if (!draft || !overlay) return;
    const value = (id) => overlay.querySelector(`#${id}`)?.value || "";
    if (overlay.querySelector("#ssEyebrow")) draft.eyebrow = value("ssEyebrow");
    if (overlay.querySelector("#ssHeading")) draft.newsletter_heading = value("ssHeading");
    if (overlay.querySelector("#ssIntro")) draft.editorial_intro = value("ssIntro");
    if (overlay.querySelector("#ssSlug")) draft.public_slug = slugify(value("ssSlug"));
    if (overlay.querySelector("#ssPublished")) draft.publication_status = overlay.querySelector("#ssPublished").checked ? "published" : "draft";
    if (overlay.querySelector("#ssHero")) draft.hero_image_url = value("ssHero");
    const ship = currentShip();
    if (ship) draft.stat_keys = technicalStats(ship).map((item) => item.key);
  }

  async function selectShip(id) {
    capture(); selectedShipId = id || ""; hostedHtmlCache = ""; previewOpen = false;
    draft = selectedShipId ? freshDraft(currentShip()) : null;
    message = ""; messageTone = ""; render();
  }

  function publicUrl() { return draft?.public_slug ? `${PUBLIC_BASE}${encodeURIComponent(draft.public_slug)}` : ""; }

  function renderTechnicalStatCell(item) {
    return `<td class="cr101-ss-stat-cell" width="33.33%" valign="top" align="center" style="width:33.33%;padding:10px 6px;vertical-align:top;text-align:center;">
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:18px;line-height:20px;color:${BRAND_DARK_GREEN};height:22px;">${esc(item.icon)}</div>
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:18px;font-weight:700;line-height:24px;color:${BODY};margin-top:4px;">${esc(item.value)}</div>
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:10px;font-weight:700;line-height:14px;letter-spacing:.7px;text-transform:uppercase;color:${MUTED};margin-top:2px;">${esc(item.label)}</div>
    </td>`;
  }

  function renderTechnicalGrid(items) {
    if (!items.length) return "";
    const rows = [];
    for (let i = 0; i < items.length; i += 3) {
      const group = items.slice(i, i + 3);
      while (group.length < 3) group.push(null);
      rows.push(`<tr>${group.map((item) => item ? renderTechnicalStatCell(item) : '<td class="cr101-ss-stat-empty" width="33.33%" style="width:33.33%;padding:0;"></td>').join("")}</tr>`);
    }
    return `<tr><td align="center" style="padding:30px 0 0;">
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${BRAND_DARK_GREEN};text-align:center;margin-bottom:12px;">SHIP AT A GLANCE</div>
      <table role="presentation" class="cr101-ss-stat-grid" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;border-top:1px solid ${DIVIDER};border-bottom:1px solid ${DIVIDER};">${rows.join("")}</table>
    </td></tr>`;
  }

  function renderOnboardCell(item) {
    return `<td class="cr101-ss-onboard-cell" width="20%" valign="top" align="center" style="width:20%;padding:8px 5px;vertical-align:top;text-align:center;">
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:20px;line-height:22px;color:${BRAND_DARK_GREEN};height:23px;">${esc(item.icon)}</div>
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:18px;font-weight:700;line-height:22px;color:${BODY};margin-top:4px;">${esc(item.value)}</div>
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:10px;font-weight:600;line-height:13px;letter-spacing:.35px;text-transform:uppercase;color:${BRAND_DARK_GREEN};margin-top:2px;">${esc(item.label)}</div>
    </td>`;
  }

  function renderOnboardGrid(items) {
    if (!items.length) return "";
    return `<tr><td align="center" style="padding:30px 0 0;">
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${BRAND_DARK_GREEN};text-align:center;margin-bottom:10px;">ON BOARD</div>
      <table role="presentation" class="cr101-ss-onboard-grid" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;border:1px solid ${BRAND_GREEN};background:#FFFFFF;"><tr>${items.map(renderOnboardCell).join("")}</tr></table>
    </td></tr>`;
  }

  function renderFeatureList(title, items) {
    if (!items.length) return "";
    const rows = items.map((text) => `<tr><td width="15" valign="top" style="width:15px;padding:5px 5px 5px 0;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:${BRAND_DARK_GREEN};">•</td><td valign="top" style="padding:5px 0;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:${BODY};">${esc(text)}</td></tr>`).join("");
    return `<td class="cr101-ss-feature-col" width="50%" valign="top" style="width:50%;padding:16px 18px;vertical-align:top;border:1px solid ${DIVIDER};background:#FFFFFF;">
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;color:${BRAND_DARK_GREEN};margin-bottom:7px;">${esc(title)}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">${rows}</table>
    </td>`;
  }

  function renderFeatures(ship) {
    const exclusive = exclusiveAreas(ship);
    const specialty = specialtyFeatures(ship);
    if (!exclusive.length && !specialty.length) return "";
    return `<tr><td align="center" style="padding:24px 0 0;"><table role="presentation" class="cr101-ss-features" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;"><tr>${exclusive.length ? renderFeatureList("Exclusive Areas", exclusive) : '<td class="cr101-ss-feature-col" width="50%" style="width:50%;"></td>'}${specialty.length ? renderFeatureList("Specialty Features", specialty) : '<td class="cr101-ss-feature-col" width="50%" style="width:50%;"></td>'}</tr></table></td></tr>`;
  }

  function emailStyleBlock() {
    return `<style type="text/css">
      @media only screen and (max-width:620px) {
        .cr101-ss-wrapper { width:100% !important; }
        .cr101-ss-stat-cell { display:inline-block !important;width:50% !important;max-width:50% !important;box-sizing:border-box !important;padding:12px 5px !important; }
        .cr101-ss-stat-empty { display:none !important; }
        .cr101-ss-onboard-cell { display:inline-block !important;width:50% !important;max-width:50% !important;box-sizing:border-box !important;padding:11px 5px !important; }
        .cr101-ss-feature-col { display:block !important;width:100% !important;max-width:100% !important;box-sizing:border-box !important;border-left:1px solid ${DIVIDER} !important;border-right:1px solid ${DIVIDER} !important; }
      }
    </style>`;
  }

  function emailHtml() {
    capture();
    const ship = currentShip(); const line = currentLine();
    if (!ship || !draft || !draft.hero_image_url) return "";
    const technical = technicalStats(ship);
    const onboard = onboardStats(ship);
    const intro = String(draft.editorial_intro || "").trim();
    const ctaUrl = publicUrl();
    const cta = ctaUrl ? `<tr><td align="center" style="padding:40px 0 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="border-collapse:collapse;"><tr><td align="center" bgcolor="#000000" style="background-color:#000000;border-radius:2px;"><a href="${esc(ctaUrl)}" target="_blank" style="font-family:Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#FFFFFF;text-decoration:none;display:inline-block;padding:14px 32px;">EXPLORE ${esc(ship.name.toUpperCase())} →</a></td></tr></table></td></tr>` : "";

    return `${emailStyleBlock()}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE_BG}" style="width:100%;border-collapse:collapse;background-color:${PAGE_BG};"><tr><td align="center" bgcolor="${PAGE_BG}" style="padding:0;background-color:${PAGE_BG};"><table role="presentation" class="cr101-ss-wrapper" width="${MAX_WIDTH}" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE_BG}" style="width:100%;max-width:${MAX_WIDTH}px;border-collapse:collapse;background-color:${PAGE_BG};"><tr><td align="center" style="padding:24px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
<tr><td align="center" style="font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:400;letter-spacing:3px;text-transform:uppercase;color:${MUTED};text-align:center;padding:0 0 18px;">${esc(draft.eyebrow || "SHIP SPOTLIGHT")}</td></tr>
<tr><td align="center" style="font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:700;line-height:1.35;color:#000000;text-align:center;padding:0 12px 8px;">${esc(draft.newsletter_heading || ship.name)}</td></tr>
<tr><td align="center" style="font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#000000;text-align:center;padding:0 0 24px;">${esc(line?.name || "")}</td></tr>
<tr><td align="center" style="padding:0;"><img src="${esc(draft.hero_image_url)}" alt="${esc(ship.name)}" width="${MAX_WIDTH}" border="0" style="display:block;width:100%;max-width:${MAX_WIDTH}px;height:auto;border:0;"></td></tr>
${renderTechnicalGrid(technical)}
${renderOnboardGrid(onboard)}
${intro ? `<tr><td align="center" style="padding:34px 0 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;"><tr><td height="1" style="height:1px;line-height:1px;font-size:0;background-color:${DIVIDER};">&nbsp;</td></tr></table></td></tr><tr><td align="center" style="padding:34px 12px 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:400;color:${BODY};text-align:center;line-height:1.65;">${esc(intro)}</td></tr>` : ""}
${renderFeatures(ship)}
${cta}
<tr><td align="center" style="padding:28px 0 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;"><tr><td style="border-top:2px dotted #c4c4c4;font-size:0;line-height:0;height:0;">&nbsp;</td></tr></table></td></tr>
</table></td></tr></table></td></tr></table>`;
  }

  async function save({ quiet = false } = {}) {
    capture(); const ship = currentShip(); if (!ship || !draft) return false;
    if (!draft.hero_image_url) { message = "Choose a hero image before saving."; messageTone = "error"; render(); return false; }
    busy = true; message = "Saving Ship Spotlight…"; messageTone = ""; render();
    const user = (await client().auth.getUser()).data?.user || null;
    const payload = {
      ship_id: ship.id,
      eyebrow: draft.eyebrow || "SHIP SPOTLIGHT",
      newsletter_heading: draft.newsletter_heading || ship.name,
      editorial_intro: draft.editorial_intro || null,
      highlights: [],
      stat_keys: technicalStats(ship).map((item) => item.key),
      hero_image_url: draft.hero_image_url,
      supporting_image_urls: draft.supporting_image_urls || [],
      public_slug: slugify(draft.public_slug || ship.slug || ship.name),
      publication_status: draft.publication_status || "draft",
      active: true,
      updated_by: user?.id || null,
      ...(draft.id ? {} : { created_by: user?.id || null })
    };
    const result = await client().from("ship_spotlights").upsert(payload, { onConflict: "ship_id" }).select("*").single();
    if (result.error) { busy = false; message = result.error.message; messageTone = "error"; render(); return false; }
    draft = { ...draft, ...result.data, stat_keys: technicalStats(ship).map((item) => item.key) };
    spotlights = spotlights.filter((r) => r.ship_id !== ship.id).concat(result.data);
    busy = false; if (!quiet) { message = "Ship Spotlight saved."; messageTone = "success"; } render(); return true;
  }

  async function prepareHostedHtml() {
    const saved = await save({ quiet: true }); if (!saved) return "";
    const rawHtml = emailHtml();
    const sourceUrl = draft.hero_image_url;
    if (!sourceUrl) return rawHtml;
    message = "Preparing Ship Spotlight image…"; messageTone = ""; busy = true; render();
    const headers = typeof global.adminAuthHeaders === "function" ? await global.adminAuthHeaders({ "Content-Type": "application/json" }) : { "Content-Type": "application/json" };
    const response = await fetch(EMAIL_ASSET_ENDPOINT, { method: "POST", headers, body: JSON.stringify({ spotlight_id: draft.id, asset_index: 1, asset_total: 1, assets: [{ source_url: sourceUrl, asset_type: "hero", label: currentShip()?.name || "ship" }] }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false || !data.mappings?.[0]?.mailchimp_file_url) throw new Error(data.error || "Could not prepare the Ship Spotlight image.");
    return rawHtml.split(sourceUrl).join(data.mappings[0].mailchimp_file_url);
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
    return `<div class="ss-preview-backdrop" onclick="if(event.target===this) ShipSpotlightAdmin.closePreview()"><div class="ss-preview-modal"><div class="ss-preview-head"><div><strong>Newsletter block preview</strong><div class="admin-small">600px email canvas. Resize the browser to inspect mobile stacking.</div></div><button class="admin-button secondary small" onclick="ShipSpotlightAdmin.closePreview()">Close</button></div><div class="ss-preview-canvas">${emailHtml()}</div></div></div>`;
  }

  function adminStatCards(ship) {
    const items = [...technicalStats(ship), ...onboardStats(ship)];
    return items.length ? items.map((item) => `<div class="ss-auto-stat"><strong>${esc(item.value)}</strong><span>${esc(item.label)}</span></div>`).join("") : '<p class="admin-muted">No populated ship statistics are available yet.</p>';
  }

  function adminFeatureSummary(ship) {
    const exclusive = exclusiveAreas(ship);
    const specialty = specialtyFeatures(ship);
    return `<div class="ss-grid two"><div><h4>Exclusive Areas</h4>${exclusive.length ? `<p>${exclusive.map(esc).join(" · ")}</p>` : '<p class="admin-muted">None recorded.</p>'}</div><div><h4>Specialty Features</h4>${specialty.length ? `<p>${specialty.map(esc).join(" · ")}</p>` : '<p class="admin-muted">None recorded.</p>'}</div></div>`;
  }

  function renderForm() {
    const ship = currentShip();
    if (!ship || !draft) return `<div class="ss-empty"><h3>Create a Ship Spotlight</h3><p>Select a ship above. Its existing database facts and hero imagery will be loaded automatically.</p></div>`;
    const line = currentLine();
    const images = shipMedia(ship.id);
    const allImageUrls = [...new Set([ship.hero_image_url, ...(Array.isArray(ship.image_gallery) ? ship.image_gallery : []), ...images.map((m) => m.public_url), draft.hero_image_url].filter(Boolean))];
    const heroOptions = allImageUrls.map((url, i) => `<option value="${esc(url)}" ${url === draft.hero_image_url ? "selected" : ""}>${esc(images.find((m) => m.public_url === url)?.title || (url === ship.hero_image_url ? "Ship hero image" : `Ship image ${i + 1}`))}</option>`).join("");

    return `<div class="ss-form"><div class="ss-identity"><div>${draft.hero_image_url ? `<img src="${esc(draft.hero_image_url)}" alt="">` : ""}</div><div><p class="admin-nav-eyebrow">${esc(line?.name || "Cruise line")}</p><h2>${esc(ship.name)}</h2><p class="admin-muted">${esc([ship.ship_class, ship.year_built ? `Built ${ship.year_built}` : ""].filter(Boolean).join(" · "))}</p></div></div>
      <section><h3>Newsletter presentation</h3><p class="admin-muted">Uses the same typography, width, spacing and brand colours as the current 101cruise newsletter. The block is responsive and stacks for phone screens.</p><div class="ss-grid two"><div class="admin-field"><label>Eyebrow</label><input id="ssEyebrow" value="${esc(draft.eyebrow)}"></div><div class="admin-field"><label>Heading</label><input id="ssHeading" value="${esc(draft.newsletter_heading)}"></div></div><div class="admin-field"><label>Short introduction</label><textarea id="ssIntro" rows="4" placeholder="40–60 words works best in the newsletter.">${esc(draft.editorial_intro)}</textarea></div></section>
      <section><h3>Ship statistics</h3><p class="admin-muted">Automatic. Every populated approved statistic is shown; blank fields are omitted completely. Calendar years are never thousands-formatted.</p><div class="ss-auto-stat-grid">${adminStatCards(ship)}</div></section>
      <section><h3>Areas & features</h3><p class="admin-muted">Pulled directly from the ship record. The newsletter uses these instead of a generic Highlights section.</p>${adminFeatureSummary(ship)}</section>
      <section><div class="ss-section-head"><div><h3>Hero image</h3><p class="admin-muted">The newsletter uses one full-width hero image only. Supporting imagery can be dealt with when we design the full ship page.</p></div><button class="admin-button secondary small" onclick="ShipSpotlightAdmin.useMediaLibrary()">Open Media Library</button></div><div class="admin-field"><label>Hero image</label><select id="ssHero" onchange="ShipSpotlightAdmin.capture(); ShipSpotlightAdmin.render()"><option value="">Select image</option>${heroOptions}</select></div></section>
      <section><h3>Public ship page</h3><div class="ss-grid two"><div class="admin-field"><label>Public slug</label><input id="ssSlug" value="${esc(draft.public_slug)}"></div><label class="ss-publish"><input id="ssPublished" type="checkbox" ${draft.publication_status === "published" ? "checked" : ""}> Publish this Ship Spotlight page</label></div><div class="admin-helper">${esc(publicUrl())}</div></section>
      <div class="ss-actions"><button class="admin-button secondary" onclick="ShipSpotlightAdmin.openPreview()">Preview Newsletter Block</button><button class="admin-button secondary" onclick="ShipSpotlightAdmin.save()" ${busy ? "disabled" : ""}>Save Spotlight</button><button class="admin-button black" onclick="ShipSpotlightAdmin.${hostedHtmlCache ? "copyAgainIfReady" : "copyNewsletterBlock"}()" ${busy ? "disabled" : ""}>${busy ? "Preparing…" : "Copy Newsletter Block"}</button></div></div>`;
  }

  function styles() {
    if (document.getElementById("shipSpotlightStyles")) return;
    const el = document.createElement("style"); el.id = "shipSpotlightStyles";
    el.textContent = `.ss-nav-btn{display:block;width:100%;border:0;background:transparent;text-align:left;padding:9px 14px 9px 28px;font:inherit;color:inherit;cursor:pointer}.ss-nav-btn:hover{background:rgba(0,0,0,.05)}.ss-overlay{position:fixed;inset:0;z-index:9998;background:#f4f5f6;overflow:auto}.ss-shell{max-width:1180px;margin:0 auto;padding:22px}.ss-top{display:flex;gap:16px;justify-content:space-between;align-items:flex-start;margin-bottom:16px}.ss-top h1{margin:2px 0 5px}.ss-top-actions{display:flex;gap:8px;align-items:center}.ss-card{background:#fff;border:1px solid #e3e6e8;border-radius:12px;padding:20px;box-shadow:0 8px 28px rgba(20,30,40,.05)}.ss-selector{display:flex;gap:12px;align-items:end;margin-bottom:16px}.ss-selector .admin-field{flex:1;margin:0}.ss-form section{padding:20px 0;border-top:1px solid #e8ebed}.ss-form section:first-of-type{border-top:0}.ss-form h3{margin:0 0 8px}.ss-form h4{margin:0 0 7px}.ss-grid{display:grid;gap:12px}.ss-grid.two{grid-template-columns:repeat(2,minmax(0,1fr))}.ss-identity{display:grid;grid-template-columns:150px 1fr;gap:18px;align-items:center;padding-bottom:20px}.ss-identity img{width:150px;height:95px;object-fit:cover;border-radius:9px}.ss-identity h2{margin:0 0 5px}.ss-section-head{display:flex;justify-content:space-between;gap:12px;align-items:start}.ss-auto-stat-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin-top:12px}.ss-auto-stat{border:1px solid #dfe3e6;border-radius:8px;padding:11px 8px;text-align:center;background:#fff}.ss-auto-stat strong{display:block;font-size:16px;color:#111}.ss-auto-stat span{display:block;margin-top:3px;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#66727c}.ss-publish{display:flex;align-items:center;gap:8px;padding-top:27px}.ss-actions{display:flex;justify-content:flex-end;gap:8px;padding-top:18px}.ss-message{margin:0 0 14px;padding:10px 12px;border-radius:8px;background:#eef2f4}.ss-message.success{background:#e9f7ef;color:#17633f}.ss-message.error{background:#fff0f0;color:#9a2525}.ss-preview-backdrop{position:fixed;inset:0;z-index:9999;background:rgba(20,25,30,.75);overflow:auto;padding:30px}.ss-preview-modal{max-width:760px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden}.ss-preview-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid #e4e7e9}.ss-preview-canvas{background:#f7f7f7;padding:18px}@media(max-width:900px){.ss-auto-stat-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:760px){.ss-grid.two{grid-template-columns:1fr}.ss-auto-stat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.ss-top{display:block}.ss-top-actions{margin-top:10px}.ss-identity{grid-template-columns:1fr}.ss-selector{display:block}.ss-selector .admin-field{margin-bottom:8px}.ss-section-head{display:block}.ss-section-head .admin-button{margin-top:8px}}`;
    document.head.appendChild(el);
  }

  function render() {
    if (!overlay) return;
    capture();
    const optionsByLine = lines.filter((l) => l.active !== false).map((line) => {
      const lineShips = ships.filter((s) => s.cruise_line_id === line.id).sort((a, b) => a.name.localeCompare(b.name));
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
