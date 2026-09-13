/* Ship Spotlight / Ship of the Week marketing workspace.
 * Deliberately separate from the cruise-specials newsletter composer.
 * Generates a standalone Mailchimp-ready HTML block which can be copied and
 * pasted into a normal newsletter code block wherever the editor chooses.
 *
 * Newsletter output deliberately follows the existing 101cruise newsletter
 * design system: 600px max width, Georgia editorial headings, Helvetica/Arial
 * supporting typography, #8DD9BF brand green and #F7F7F7 page background.
 */
(function (global) {
  "use strict";

  const PUBLIC_BASE = "https://101cruise.com.au/ships/";
  const EMAIL_ASSET_ENDPOINT = "/.netlify/functions/ship-spotlight-mailchimp-assets";
  const MAX_WIDTH = 600;
  const BRAND_GREEN = "#8DD9BF";
  const BRAND_DARK_GREEN = "#245C4E";
  const PAGE_BG = "#F7F7F7";
  const BODY = "#111111";
  const MUTED = "#545454";
  const DIVIDER = "#E8E8E8";

  const PRIMARY_STATS = [
    ["passenger_capacity", "Guests", "PEOPLE"],
    ["stateroom_count", "Staterooms", "ROOM"],
    ["crew_count", "Crew", "CREW"],
    ["year_built", "Built", "YEAR"],
    ["year_refurbished", "Refurbished", "REFIT"],
    ["gross_tonnage", "Tonnage", "GT"],
    ["length_metres", "Length", "LENGTH"],
    ["beam_metres", "Beam", "BEAM"],
    ["cruising_speed_knots", "Cruising Speed", "SPEED"],
    ["deck_count", "Decks", "DECKS"]
  ];

  const ONBOARD_STATS = [
    ["restaurants", "Dining Options", "DINING"],
    ["bars", "Bars", "BARS"],
    ["pools", "Pools", "POOLS"],
    ["hot_tubs", "Hot Tubs", "HOT TUBS"],
    ["specialty_dining", "Specialty Dining", "SPECIALTY"]
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
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  function slugify(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "ship";
  }

  function client() {
    if (!global.supabaseClient) {
      throw new Error("Supabase client is unavailable. Reload Admin and try again.");
    }
    return global.supabaseClient;
  }

  function shipById(id) { return ships.find((row) => row.id === id) || null; }
  function lineById(id) { return lines.find((row) => row.id === id) || null; }
  function currentShip() { return shipById(selectedShipId); }
  function currentLine() {
    const ship = currentShip();
    return ship ? lineById(ship.cruise_line_id) : null;
  }

  function shipMedia(id) {
    return media
      .filter((row) => row.ship_id === id && row.is_active !== false && row.public_url)
      .sort((a, b) =>
        Number(Boolean(b.is_default)) - Number(Boolean(a.is_default)) ||
        String(a.title || "").localeCompare(String(b.title || ""))
      );
  }

  function shipResearch(id) {
    return (
      research.find((row) =>
        row.entity_type === "ship" &&
        row.entity_id === id &&
        ["published", "reviewed"].includes(row.content_status)
      ) ||
      research.find((row) => row.entity_type === "ship" && row.entity_id === id) ||
      null
    );
  }

  function freshDraft(ship) {
    const existing = spotlights.find((row) => row.ship_id === ship.id);
    const researchRow = shipResearch(ship.id);
    const images = shipMedia(ship.id);
    const gallery = Array.isArray(ship.image_gallery) ? ship.image_gallery : [];
    const hero =
      existing?.hero_image_url ||
      ship.hero_image_url ||
      images.find((row) => row.is_default)?.public_url ||
      images[0]?.public_url ||
      gallery[0] ||
      "";

    return {
      id: existing?.id || null,
      ship_id: ship.id,
      eyebrow: existing?.eyebrow || "SHIP SPOTLIGHT",
      newsletter_heading: existing?.newsletter_heading || ship.name,
      editorial_intro: existing?.editorial_intro || researchRow?.summary_text || "",
      hero_image_url: hero,
      supporting_image_urls: existing?.supporting_image_urls || [],
      public_slug: existing?.public_slug || ship.slug || slugify(ship.name),
      publication_status: existing?.publication_status || "draft",
      active: existing?.active !== false
    };
  }

  async function ensureLoaded(force = false) {
    if (loaded && !force) return;
    busy = true;
    message = "Loading Ship Spotlights…";
    messageTone = "";
    render();

    const db = client();
    const [shipRes, lineRes, spotlightRes, mediaRes, researchRes] = await Promise.all([
      db.from("ci_cruise_ships")
        .select("id,cruise_line_id,name,slug,status,ship_class,year_built,year_refurbished,passenger_capacity,crew_count,deck_count,stateroom_count,gross_tonnage,length_metres,beam_metres,cruising_speed_knots,facilities,hero_image_url,image_gallery,active")
        .eq("active", true)
        .order("name"),
      db.from("ci_cruise_lines")
        .select("id,name,slug,logo_url,active,sold_by_101cruise")
        .order("name"),
      db.from("ship_spotlights").select("*").order("updated_at", { ascending: false }),
      db.from("media_library")
        .select("id,title,alt_text,public_url,ship_id,is_default,is_active,media_type")
        .eq("media_type", "ship")
        .eq("is_active", true),
      db.from("research_content")
        .select("id,entity_type,entity_id,content_status,content_json,summary_text,pauls_tip,canonical_slug")
        .eq("entity_type", "ship")
    ]);

    const failed = [shipRes, lineRes, spotlightRes, mediaRes, researchRes].find((r) => r.error);
    if (failed) throw failed.error;

    ships = shipRes.data || [];
    lines = lineRes.data || [];
    spotlights = spotlightRes.data || [];
    media = mediaRes.data || [];
    research = researchRes.data || [];
    loaded = true;
    busy = false;
    message = "";
    render();
  }

  function capture() {
    if (!draft || !overlay) return;
    const value = (id) => overlay.querySelector(`#${id}`)?.value || "";
    draft.eyebrow = value("ssEyebrow");
    draft.newsletter_heading = value("ssHeading");
    draft.editorial_intro = value("ssIntro");
    draft.public_slug = slugify(value("ssSlug"));
    draft.publication_status = overlay.querySelector("#ssPublished")?.checked ? "published" : "draft";
    draft.hero_image_url = value("ssHero");
  }

  async function selectShip(id) {
    capture();
    selectedShipId = id || "";
    hostedHtmlCache = "";
    previewOpen = false;
    draft = selectedShipId ? freshDraft(currentShip()) : null;
    message = "";
    messageTone = "";
    render();
  }

  function isUsefulNumber(value) {
    if (value == null || value === "") return false;
    const n = Number(value);
    return Number.isFinite(n) && n > 0;
  }

  function literalYear(value) {
    if (value == null || value === "") return "";
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return "";
    return String(Math.trunc(n));
  }

  function compactNumber(value, maximumFractionDigits = 1) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return "";
    return n.toLocaleString("en-AU", { maximumFractionDigits });
  }

  function statValue(ship, key) {
    const raw = ship?.[key];
    if (raw == null || raw === "") return "";
    if (key === "year_built" || key === "year_refurbished") return literalYear(raw);
    if (key === "gross_tonnage") return isUsefulNumber(raw) ? `${compactNumber(raw, 0)} GT` : "";
    if (key === "length_metres" || key === "beam_metres") return isUsefulNumber(raw) ? `${compactNumber(raw, 1)} m` : "";
    if (key === "cruising_speed_knots") return isUsefulNumber(raw) ? `${compactNumber(raw, 1)} knots` : "";
    if (["passenger_capacity", "crew_count", "deck_count", "stateroom_count"].includes(key)) {
      return isUsefulNumber(raw) ? compactNumber(raw, 0) : "";
    }
    return String(raw).trim();
  }

  function primaryStats(ship) {
    return PRIMARY_STATS.map(([key, label, icon]) => {
      const value = statValue(ship, key);
      return value ? { key, label, icon, value } : null;
    }).filter(Boolean);
  }

  function onboardStats(ship) {
    const facilities = ship?.facilities && typeof ship.facilities === "object" ? ship.facilities : {};
    return ONBOARD_STATS.map(([key, label, icon]) => {
      const raw = facilities[key];
      const value = isUsefulNumber(raw) ? compactNumber(raw, 0) : "";
      return value ? { key, label, icon, value } : null;
    }).filter(Boolean);
  }

  function normalizeFeatureList(value) {
    const list = Array.isArray(value) ? value : value ? [value] : [];
    const out = [];
    for (const item of list) {
      String(item || "")
        .replace(/\s+and\s+/gi, ", ")
        .split(",")
        .map((part) => part.trim().replace(/^and\s+/i, ""))
        .filter(Boolean)
        .forEach((part) => {
          if (!out.some((existing) => existing.toLowerCase() === part.toLowerCase())) out.push(part);
        });
    }
    return out;
  }

  function exclusiveAreas(ship) {
    return normalizeFeatureList(ship?.facilities?.exclusive_areas);
  }

  function specialtyFeatures(ship) {
    return normalizeFeatureList(ship?.facilities?.specialty_features);
  }

  function publicUrl() {
    return draft?.public_slug ? `${PUBLIC_BASE}${encodeURIComponent(draft.public_slug)}` : "";
  }

  function statBadge(icon) {
    const label = String(icon || "").slice(0, 8);
    return `<div style="display:inline-block;min-width:42px;padding:6px 7px;margin:0 auto 7px;border-radius:999px;background-color:#D9F2E8;font-family:Helvetica,Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:.5px;line-height:1;color:${BRAND_DARK_GREEN};text-transform:uppercase;">${esc(label)}</div>`;
  }

  function renderPrimaryStatCell(item) {
    return `<td class="cr101-ss-stat" width="33.33%" valign="top" align="center" style="width:33.33%;padding:12px 6px 14px;vertical-align:top;text-align:center;border-top:1px solid ${DIVIDER};">
      ${statBadge(item.icon)}
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:18px;font-weight:700;line-height:1.2;color:${BODY};">${esc(item.value)}</div>
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:.8px;line-height:1.35;color:${MUTED};text-transform:uppercase;margin-top:4px;">${esc(item.label)}</div>
    </td>`;
  }

  function renderPrimaryStats(ship) {
    const stats = primaryStats(ship);
    if (!stats.length) return "";
    const rows = [];
    for (let i = 0; i < stats.length; i += 3) {
      const chunk = stats.slice(i, i + 3);
      while (chunk.length < 3) chunk.push(null);
      rows.push(`<tr class="cr101-ss-stat-row">${chunk.map((item) => item ? renderPrimaryStatCell(item) : '<td class="cr101-ss-stat cr101-ss-stat-empty" width="33.33%" style="width:33.33%;"></td>').join("")}</tr>`);
    }
    return `
      <tr><td align="center" style="padding:34px 0 10px;font-family:Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${BRAND_DARK_GREEN};">SHIP AT A GLANCE</td></tr>
      <tr><td align="center" style="padding:0;"><table role="presentation" class="cr101-ss-stats" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">${rows.join("")}</table></td></tr>`;
  }

  function renderOnboardStatCell(item) {
    return `<td class="cr101-ss-onboard-item" width="20%" valign="top" align="center" style="width:20%;padding:8px 5px 12px;vertical-align:top;text-align:center;">
      ${statBadge(item.icon)}
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:18px;font-weight:700;line-height:1.2;color:${BODY};">${esc(item.value)}</div>
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:10px;font-weight:600;line-height:1.3;color:${MUTED};margin-top:3px;">${esc(item.label)}</div>
    </td>`;
  }

  function renderOnboard(ship) {
    const items = onboardStats(ship);
    if (!items.length) return "";
    return `
      <tr><td align="center" style="padding:32px 0 10px;font-family:Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${BRAND_DARK_GREEN};">ON BOARD</td></tr>
      <tr><td align="center" style="padding:0 0 4px;"><table role="presentation" class="cr101-ss-onboard" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;border-top:1px solid ${DIVIDER};border-bottom:1px solid ${DIVIDER};"><tr>${items.map(renderOnboardStatCell).join("")}</tr></table></td></tr>`;
  }

  function renderFeatureColumn(title, items) {
    if (!items.length) return "";
    const rows = items.map((item) => `<div style="font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.45;color:${BODY};padding:4px 0;"><span style="color:${BRAND_DARK_GREEN};font-weight:700;padding-right:6px;">•</span>${esc(item)}</div>`).join("");
    return `<td class="cr101-ss-feature-col" width="50%" valign="top" style="width:50%;padding:0 16px 0;vertical-align:top;">
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${BRAND_DARK_GREEN};margin-bottom:7px;">${esc(title)}</div>
      ${rows}
    </td>`;
  }

  function renderFeatures(ship) {
    const exclusive = exclusiveAreas(ship);
    const specialty = specialtyFeatures(ship);
    if (!exclusive.length && !specialty.length) return "";
    const left = renderFeatureColumn("Exclusive Areas", exclusive);
    const right = renderFeatureColumn("Specialty Features", specialty);
    return `
      <tr><td align="center" style="padding:34px 0 0;"><table role="presentation" class="cr101-ss-features" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;"><tr>${left || '<td class="cr101-ss-feature-col" width="50%"></td>'}${right || '<td class="cr101-ss-feature-col" width="50%"></td>'}</tr></table></td></tr>`;
  }

  function emailCss() {
    return `<style type="text/css">
      @media only screen and (max-width:620px){
        .cr101-ss-wrapper{width:100%!important;}
        .cr101-ss-stat{display:inline-block!important;width:50%!important;max-width:50%!important;box-sizing:border-box!important;}
        .cr101-ss-stat-empty{display:none!important;}
        .cr101-ss-stat-row{display:block!important;text-align:center!important;}
        .cr101-ss-onboard-item{display:inline-block!important;width:50%!important;max-width:50%!important;box-sizing:border-box!important;padding:10px 6px!important;}
        .cr101-ss-onboard tr{display:block!important;text-align:center!important;}
        .cr101-ss-feature-col{display:block!important;width:100%!important;max-width:100%!important;box-sizing:border-box!important;padding:0 8px 22px!important;text-align:center!important;}
        .cr101-ss-heading{font-size:22px!important;line-height:1.35!important;}
        .cr101-ss-inner{padding-left:16px!important;padding-right:16px!important;}
      }
    </style>`;
  }

  function emailHtml() {
    capture();
    const ship = currentShip();
    const line = currentLine();
    if (!ship || !draft) return "";

    const hero = draft.hero_image_url
      ? `<tr><td align="center" style="padding:0 0 36px;"><img src="${esc(draft.hero_image_url)}" alt="${esc(ship.name)}" width="${MAX_WIDTH}" border="0" style="display:block;width:100%;max-width:${MAX_WIDTH}px;height:auto;border:0;"></td></tr>`
      : "";

    const intro = String(draft.editorial_intro || "").trim()
      ? `<tr><td align="center" style="padding:34px 12px 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:400;line-height:1.65;color:${BODY};text-align:center;">${esc(draft.editorial_intro)}</td></tr>`
      : "";

    const cta = publicUrl()
      ? `<tr><td align="center" style="padding:40px 0 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="border-collapse:collapse;"><tr><td align="center" bgcolor="#000000" style="background-color:#000000;border-radius:2px;"><a href="${esc(publicUrl())}" target="_blank" style="font-family:Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#FFFFFF;text-decoration:none;display:inline-block;padding:14px 32px;">EXPLORE ${esc(ship.name.toUpperCase())} →</a></td></tr></table></td></tr>`
      : "";

    return `${emailCss()}
<table role="presentation" class="cr101-ss-outer" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE_BG}" style="width:100%;border-collapse:collapse;background-color:${PAGE_BG};">
  <tr>
    <td align="center" bgcolor="${PAGE_BG}" style="padding:0;background-color:${PAGE_BG};">
      <table role="presentation" class="cr101-ss-wrapper" width="${MAX_WIDTH}" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE_BG}" style="width:100%;max-width:${MAX_WIDTH}px;border-collapse:collapse;background-color:${PAGE_BG};">
        <tr>
          <td class="cr101-ss-inner" align="center" bgcolor="${PAGE_BG}" style="padding:24px 16px 48px;background-color:${PAGE_BG};">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
              <tr><td align="center" style="font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:400;letter-spacing:3px;text-transform:uppercase;color:${MUTED};text-align:center;padding:0 0 38px;">${esc(draft.eyebrow || "SHIP SPOTLIGHT")}</td></tr>
              <tr><td class="cr101-ss-heading" align="center" style="font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:700;line-height:1.35;color:#000000;text-align:center;padding:0 12px 8px;">${esc(draft.newsletter_heading || ship.name)}</td></tr>
              <tr><td align="center" style="font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#000000;text-align:center;padding:0 0 24px;">${esc(line?.name || "")}</td></tr>
              ${hero}
              ${renderPrimaryStats(ship)}
              ${renderOnboard(ship)}
              ${intro}
              ${renderFeatures(ship)}
              ${cta}
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
  }

  async function save({ quiet = false } = {}) {
    capture();
    const ship = currentShip();
    if (!ship || !draft) return false;
    if (!draft.hero_image_url) {
      message = "Choose a hero image before saving.";
      messageTone = "error";
      render();
      return false;
    }

    busy = true;
    message = "Saving Ship Spotlight…";
    messageTone = "";
    render();

    const user = (await client().auth.getUser()).data?.user || null;
    const autoStatKeys = primaryStats(ship).map((item) => item.key);
    const payload = {
      ship_id: ship.id,
      eyebrow: draft.eyebrow || "SHIP SPOTLIGHT",
      newsletter_heading: draft.newsletter_heading || ship.name,
      editorial_intro: draft.editorial_intro || null,
      highlights: [],
      stat_keys: autoStatKeys,
      hero_image_url: draft.hero_image_url,
      supporting_image_urls: draft.supporting_image_urls || [],
      public_slug: slugify(draft.public_slug || ship.slug || ship.name),
      publication_status: draft.publication_status || "draft",
      active: true,
      updated_by: user?.id || null,
      ...(draft.id ? {} : { created_by: user?.id || null })
    };

    const result = await client()
      .from("ship_spotlights")
      .upsert(payload, { onConflict: "ship_id" })
      .select("*")
      .single();

    if (result.error) {
      busy = false;
      message = result.error.message;
      messageTone = "error";
      render();
      return false;
    }

    draft = { ...draft, ...result.data };
    spotlights = spotlights.filter((row) => row.ship_id !== ship.id).concat(result.data);
    busy = false;
    if (!quiet) {
      message = "Ship Spotlight saved.";
      messageTone = "success";
    }
    render();
    return true;
  }

  async function prepareHostedHtml() {
    const saved = await save({ quiet: true });
    if (!saved) return "";
    const rawHtml = emailHtml();
    const sourceUrl = String(draft.hero_image_url || "").trim();
    if (!sourceUrl) return rawHtml;

    busy = true;
    message = "Preparing Ship Spotlight image…";
    messageTone = "";
    render();

    const headers = typeof global.adminAuthHeaders === "function"
      ? await global.adminAuthHeaders({ "Content-Type": "application/json" })
      : { "Content-Type": "application/json" };

    const response = await fetch(EMAIL_ASSET_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({
        spotlight_id: draft.id,
        asset_index: 1,
        asset_total: 1,
        assets: [{ source_url: sourceUrl, asset_type: "hero", label: currentShip()?.name || "ship" }]
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false || !data.mappings?.[0]?.mailchimp_file_url) {
      throw new Error(data.error || "Could not prepare the Ship Spotlight image.");
    }
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
          if (result.code === "clipboard_blocked") {
            message = "The block is ready. Click Copy Newsletter Block again and it will copy immediately.";
            messageTone = "success";
            busy = false;
            render();
            return;
          }
          throw new Error(result.error || "Could not copy the newsletter block.");
        }
      } else {
        await navigator.clipboard.writeText(hostedHtmlCache);
      }
      busy = false;
      message = "Newsletter block copied. Paste it into a normal newsletter code block wherever you want it.";
      messageTone = "success";
      render();
    } catch (error) {
      busy = false;
      message = error.message || "Could not prepare the newsletter block.";
      messageTone = "error";
      render();
    }
  }

  async function copyAgainIfReady() {
    if (!hostedHtmlCache) return copyNewsletterBlock();
    try {
      const result = global.NewsletterMailchimpAssets?.copyHostedHtml
        ? await global.NewsletterMailchimpAssets.copyHostedHtml(hostedHtmlCache)
        : (await navigator.clipboard.writeText(hostedHtmlCache), { ok: true });
      if (!result.ok) throw new Error(result.error || "Could not copy HTML.");
      message = "Newsletter block copied. Paste it into a normal newsletter code block wherever you want it.";
      messageTone = "success";
      render();
    } catch (error) {
      message = error.message;
      messageTone = "error";
      render();
    }
  }

  function openPreview() {
    capture();
    previewOpen = true;
    render();
  }

  function closePreview() {
    previewOpen = false;
    render();
  }

  function useMediaLibrary() {
    close();
    if (typeof global.setActiveTab === "function") global.setActiveTab("media-library");
  }

  function renderPreview() {
    if (!previewOpen || !draft) return "";
    return `<div class="ss-preview-backdrop" onclick="if(event.target===this) ShipSpotlightAdmin.closePreview()">
      <div class="ss-preview-modal">
        <div class="ss-preview-head"><strong>Newsletter block preview</strong><button class="admin-button secondary small" onclick="ShipSpotlightAdmin.closePreview()">Close</button></div>
        <div class="ss-preview-canvas">${emailHtml()}</div>
      </div>
    </div>`;
  }

  function renderForm() {
    const ship = currentShip();
    if (!ship || !draft) {
      return `<div class="ss-empty"><h3>Create a Ship Spotlight</h3><p>Select a ship above. Its existing database facts and images will be loaded automatically.</p></div>`;
    }

    const line = currentLine();
    const images = shipMedia(ship.id);
    const allImageUrls = [...new Set([
      ship.hero_image_url,
      ...(Array.isArray(ship.image_gallery) ? ship.image_gallery : []),
      ...images.map((row) => row.public_url),
      draft.hero_image_url
    ].filter(Boolean))];

    const heroOptions = allImageUrls.map((url, index) => {
      const title = images.find((row) => row.public_url === url)?.title ||
        (url === ship.hero_image_url ? "Ship hero image" : `Ship image ${index + 1}`);
      return `<option value="${esc(url)}" ${url === draft.hero_image_url ? "selected" : ""}>${esc(title)}</option>`;
    }).join("");

    const primary = primaryStats(ship);
    const onboard = onboardStats(ship);
    const exclusive = exclusiveAreas(ship);
    const specialty = specialtyFeatures(ship);

    const primaryPreview = primary.length
      ? primary.map((item) => `<div class="ss-auto-stat"><strong>${esc(item.value)}</strong><span>${esc(item.label)}</span></div>`).join("")
      : '<p class="admin-muted">No populated ship statistics are available yet.</p>';

    const onboardPreview = onboard.length
      ? onboard.map((item) => `<div class="ss-auto-stat"><strong>${esc(item.value)}</strong><span>${esc(item.label)}</span></div>`).join("")
      : '<p class="admin-muted">No numeric onboard statistics are available yet.</p>';

    return `<div class="ss-form">
      <div class="ss-identity">
        <div>${draft.hero_image_url ? `<img src="${esc(draft.hero_image_url)}" alt="">` : ""}</div>
        <div>
          <p class="admin-nav-eyebrow">${esc(line?.name || "Cruise line")}</p>
          <h2>${esc(ship.name)}</h2>
          <p class="admin-muted">${esc([ship.ship_class, ship.year_built ? `Built ${literalYear(ship.year_built)}` : ""].filter(Boolean).join(" · "))}</p>
        </div>
      </div>

      <section>
        <h3>Newsletter presentation</h3>
        <p class="admin-muted">This block uses the same typography, 600px width, brand green and mobile behaviour as the current newsletter.</p>
        <div class="ss-grid two">
          <div class="admin-field"><label>Eyebrow</label><input id="ssEyebrow" value="${esc(draft.eyebrow)}"></div>
          <div class="admin-field"><label>Heading</label><input id="ssHeading" value="${esc(draft.newsletter_heading)}"></div>
        </div>
        <div class="admin-field">
          <label>Short introduction</label>
          <textarea id="ssIntro" rows="4">${esc(draft.editorial_intro)}</textarea>
          <div class="admin-helper">Aim for about 40–60 words. This remains editable.</div>
        </div>
      </section>

      <section>
        <h3>Ship at a glance</h3>
        <p class="admin-muted">All populated approved statistics are included automatically. Empty fields are omitted. Years are never formatted with thousands separators.</p>
        <div class="ss-auto-stat-grid">${primaryPreview}</div>
      </section>

      <section>
        <h3>On board</h3>
        <p class="admin-muted">Numeric onboard facts are pulled automatically from the ship facilities data.</p>
        <div class="ss-auto-stat-grid">${onboardPreview}</div>
      </section>

      <section>
        <h3>Distinctive ship features</h3>
        <div class="ss-grid two">
          <div><strong>Exclusive Areas</strong><p class="admin-muted">${esc(exclusive.join(" · ") || "No exclusive areas recorded")}</p></div>
          <div><strong>Specialty Features</strong><p class="admin-muted">${esc(specialty.join(" · ") || "No specialty features recorded")}</p></div>
        </div>
      </section>

      <section>
        <div class="ss-section-head">
          <div><h3>Hero image</h3><p class="admin-muted">One full-width image, matching the current newsletter structure. Additional gallery images are reserved for the public ship page.</p></div>
          <button class="admin-button secondary small" onclick="ShipSpotlightAdmin.useMediaLibrary()">Open Media Library</button>
        </div>
        <div class="admin-field">
          <label>Hero image</label>
          <select id="ssHero" onchange="ShipSpotlightAdmin.capture(); ShipSpotlightAdmin.render()"><option value="">Select image</option>${heroOptions}</select>
        </div>
      </section>

      <section>
        <h3>Public ship page</h3>
        <p class="admin-muted">The newsletter block is the current focus. Public-page presentation will be refined separately.</p>
        <div class="ss-grid two">
          <div class="admin-field"><label>Public slug</label><input id="ssSlug" value="${esc(draft.public_slug)}"></div>
          <label class="ss-publish"><input id="ssPublished" type="checkbox" ${draft.publication_status === "published" ? "checked" : ""}> Publish this Ship Spotlight page</label>
        </div>
        <div class="admin-helper">${esc(publicUrl())}</div>
      </section>

      <div class="ss-actions">
        <button class="admin-button secondary" onclick="ShipSpotlightAdmin.openPreview()">Preview Newsletter Block</button>
        <button class="admin-button secondary" onclick="ShipSpotlightAdmin.save()" ${busy ? "disabled" : ""}>Save Spotlight</button>
        <button class="admin-button black" onclick="ShipSpotlightAdmin.${hostedHtmlCache ? "copyAgainIfReady" : "copyNewsletterBlock"}()" ${busy ? "disabled" : ""}>${busy ? "Preparing…" : "Copy Newsletter Block"}</button>
      </div>
    </div>`;
  }

  function styles() {
    if (document.getElementById("shipSpotlightStyles")) return;
    const el = document.createElement("style");
    el.id = "shipSpotlightStyles";
    el.textContent = `.ss-nav-btn{display:block;width:100%;border:0;background:transparent;text-align:left;padding:9px 14px 9px 28px;font:inherit;color:inherit;cursor:pointer}.ss-nav-btn:hover{background:rgba(0,0,0,.05)}.ss-overlay{position:fixed;inset:0;z-index:9998;background:#f4f5f6;overflow:auto}.ss-shell{max-width:1180px;margin:0 auto;padding:22px}.ss-top{display:flex;gap:16px;justify-content:space-between;align-items:flex-start;margin-bottom:16px}.ss-top h1{margin:2px 0 5px}.ss-top-actions{display:flex;gap:8px;align-items:center}.ss-card{background:#fff;border:1px solid #e3e6e8;border-radius:12px;padding:20px;box-shadow:0 8px 28px rgba(20,30,40,.05)}.ss-selector{display:flex;gap:12px;align-items:end;margin-bottom:16px}.ss-selector .admin-field{flex:1;margin:0}.ss-form section{padding:20px 0;border-top:1px solid #e8ebed}.ss-form section:first-of-type{border-top:0}.ss-form h3{margin:0 0 12px}.ss-grid{display:grid;gap:12px}.ss-grid.two{grid-template-columns:repeat(2,minmax(0,1fr))}.ss-identity{display:grid;grid-template-columns:150px 1fr;gap:18px;align-items:center;padding-bottom:20px}.ss-identity img{width:150px;height:95px;object-fit:cover;border-radius:9px}.ss-identity h2{margin:0 0 5px}.ss-auto-stat-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px}.ss-auto-stat{padding:11px 8px;border:1px solid #dfe3e6;border-radius:8px;text-align:center}.ss-auto-stat strong{display:block;font-size:16px;color:#111}.ss-auto-stat span{display:block;margin-top:3px;font-size:11px;color:#6d757d}.ss-section-head{display:flex;justify-content:space-between;gap:12px;align-items:start}.ss-publish{display:flex;align-items:center;gap:8px;padding-top:27px}.ss-actions{display:flex;justify-content:flex-end;gap:8px;padding-top:18px}.ss-message{margin:0 0 14px;padding:10px 12px;border-radius:8px;background:#eef2f4}.ss-message.success{background:#e9f7ef;color:#17633f}.ss-message.error{background:#fff0f0;color:#9a2525}.ss-preview-backdrop{position:fixed;inset:0;z-index:9999;background:rgba(20,25,30,.75);overflow:auto;padding:30px}.ss-preview-modal{max-width:760px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden}.ss-preview-head{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid #e4e7e9}.ss-preview-canvas{background:#f7f7f7;padding:18px}@media(max-width:760px){.ss-grid.two{grid-template-columns:1fr}.ss-auto-stat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.ss-top{display:block}.ss-top-actions{margin-top:10px}.ss-identity{grid-template-columns:1fr}.ss-selector{display:block}.ss-selector .admin-field{margin-bottom:8px}}`;
    document.head.appendChild(el);
  }

  function render() {
    if (!overlay) return;
    capture();
    const optionsByLine = lines
      .filter((line) => line.active !== false)
      .map((line) => {
        const lineShips = ships
          .filter((ship) => ship.cruise_line_id === line.id)
          .sort((a, b) => a.name.localeCompare(b.name));
        if (!lineShips.length) return "";
        return `<optgroup label="${esc(line.name)}">${lineShips.map((ship) => `<option value="${esc(ship.id)}" ${ship.id === selectedShipId ? "selected" : ""}>${esc(ship.name)}${spotlights.some((spotlight) => spotlight.ship_id === ship.id) ? " · Spotlight saved" : ""}</option>`).join("")}</optgroup>`;
      })
      .join("");

    overlay.innerHTML = `<div class="ss-shell">
      <div class="ss-top">
        <div><p class="admin-nav-eyebrow">Marketing</p><h1>Ship Spotlights</h1><p class="admin-muted">Create the Ship Spotlight separately, then copy its standalone HTML into a normal newsletter code block wherever you want it.</p></div>
        <div class="ss-top-actions"><button class="admin-button secondary" onclick="ShipSpotlightAdmin.ensureLoaded(true)" ${busy ? "disabled" : ""}>Refresh</button><button class="admin-button secondary" onclick="ShipSpotlightAdmin.close()">Close</button></div>
      </div>
      ${message ? `<div class="ss-message ${messageTone}">${esc(message)}</div>` : ""}
      <div class="ss-card">
        <div class="ss-selector">
          <div class="admin-field"><label>Ship</label><select onchange="ShipSpotlightAdmin.selectShip(this.value)" ${busy ? "disabled" : ""}><option value="">Select a ship</option>${optionsByLine}</select></div>
          ${draft?.id ? `<div class="admin-small">Saved spotlight · ${esc(draft.publication_status || "draft")}</div>` : ""}
        </div>
        ${busy && !loaded ? '<p class="admin-muted">Loading ship database…</p>' : renderForm()}
      </div>
    </div>${renderPreview()}`;
  }

  async function open() {
    styles();
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "ss-overlay";
      overlay.id = "shipSpotlightOverlay";
      document.body.appendChild(overlay);
    }
    overlay.hidden = false;
    render();
    try {
      await ensureLoaded();
    } catch (error) {
      busy = false;
      message = error.message || "Could not load Ship Spotlights.";
      messageTone = "error";
      render();
    }
  }

  function close() {
    if (overlay) overlay.hidden = true;
  }

  function injectNav() {
    const group = document.querySelector('[data-admin-nav-group="marketing"]');
    if (!group || group.querySelector('[data-ship-spotlight-nav]')) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ss-nav-btn";
    btn.dataset.shipSpotlightNav = "true";
    btn.textContent = "Ship Spotlight";
    btn.addEventListener("click", open);
    const container = group.querySelector(".admin-nav-children,.admin-nav-items,.admin-nav-submenu") || group;
    container.appendChild(btn);
  }

  styles();
  injectNav();
  new MutationObserver(injectNav).observe(document.documentElement, { childList: true, subtree: true });

  global.ShipSpotlightAdmin = {
    open,
    close,
    ensureLoaded,
    selectShip,
    render,
    capture,
    save,
    openPreview,
    closePreview,
    copyNewsletterBlock,
    copyAgainIfReady,
    useMediaLibrary,
    emailHtml
  };
})(window);
