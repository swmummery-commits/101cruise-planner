/* Ship Spotlight / Ship of the Week marketing workspace.
 * Standalone Mailchimp-ready block, deliberately separate from cruise specials.
 * Uses the same ship facts, room reconciliation and feature normalisation as My Cruise → My Ship.
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
  const ROOM_COLORS = ["#8DD9BF", "#5BBFA3", "#245C4E", "#9AA7A3", "#6FA894", "#3D7A6A"];

  // Exact icons used by the shared My Cruise → My Ship presentation.
  const MY_SHIP_SUMMARY_ICONS = {
    passenger_capacity: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    stateroom_count: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 20v-8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8"/><path d="M4 10V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4"/><path d="M12 4v6"/><path d="M2 18h20"/></svg>`,
    crew_count: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4z"/><path d="M4 21a8 8 0 0 1 16 0"/><path d="M12 12v3"/><path d="M9.5 16.5h5"/></svg>`,
    year_built: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg>`,
    year_refurbished: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>`
  };

  const MY_SHIP_GLANCE_ICONS = {
    restaurants: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7c0 1.1.9 2 2 2h0a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2v0a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/></svg>`,
    bars: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 22h8"/><path d="M12 11v11"/><path d="m19 3-7 8-7-8z"/></svg>`,
    pools: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 20c.6.5 1.2 1 2.5 1 2.5 0 3-2 6-2s3.5 2 6 2 2.5 0 3.5-1"/><path d="M2 16c.6.5 1.2 1 2.5 1 2.5 0 3-2 6-2s3.5 2 6 2 2.5 0 3.5-1"/><path d="M12 4v8"/><path d="M8 8h8"/></svg>`,
    hot_tubs: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h20"/><path d="M7 12v4a3 3 0 0 0 3 3h4a3 3 0 0 0 3-3v-4"/><path d="M9 7c.5-1 1.5-2 3-2s2.5 1 3 2"/><path d="M8 4c.5-1 1.5-2 4-2s3.5 1 4 2"/></svg>`,
    specialty_dining: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7c0 1.1.9 2 2 2h0a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2v0a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/></svg>`
  };

  const SUMMARY_STATS = [
    { key: "passenger_capacity", label: "Guests" },
    { key: "stateroom_count", label: "Staterooms" },
    { key: "crew_count", label: "Crew" },
    { key: "year_built", label: "Built" },
    { key: "year_refurbished", label: "Refurbished" }
  ];

  const TECHNICAL_DETAIL_STATS = [
    { key: "gross_tonnage", label: "Gross Tonnage" },
    { key: "length_metres", label: "Length" },
    { key: "beam_metres", label: "Beam" },
    { key: "cruising_speed_knots", label: "Cruising Speed" },
    { key: "deck_count", label: "Decks" }
  ];

  const ONBOARD_STATS = [
    { key: "restaurants", label: "Dining Options", aliases: ["restaurants", "restaurant_count", "restaurant"] },
    { key: "bars", label: "Bars", aliases: ["bars", "bar_count", "bar"] },
    { key: "pools", label: "Pools", aliases: ["pools", "pool_count", "pool"] },
    { key: "hot_tubs", label: "Hot Tubs", aliases: ["hot_tubs", "hotTubs", "hot_tub_count", "jacuzzis"] },
    { key: "specialty_dining", label: "Specialty Dining", aliases: ["specialty_dining", "specialtyDining", "specialty_restaurants"] }
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

  const escXml = (value) => String(value == null ? "" : value)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");

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

  function readFacilityValue(facilities, keys) {
    if (!facilities || typeof facilities !== "object" || Array.isArray(facilities)) return null;
    for (const key of keys || []) {
      if (Object.prototype.hasOwnProperty.call(facilities, key) && facilities[key] !== undefined) return facilities[key];
    }
    return null;
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

  function statsFromDefinitions(ship, definitions) {
    return definitions.map((item) => {
      const value = formatStatValue(ship, item.key);
      return value ? { ...item, value } : null;
    }).filter(Boolean);
  }

  function summaryStats(ship) { return statsFromDefinitions(ship, SUMMARY_STATS); }
  function technicalDetailStats(ship) { return statsFromDefinitions(ship, TECHNICAL_DETAIL_STATS); }
  function technicalStats(ship) { return [...summaryStats(ship), ...technicalDetailStats(ship)]; }

  function onboardStats(ship) {
    const facilities = ship?.facilities && typeof ship.facilities === "object" ? ship.facilities : {};
    return ONBOARD_STATS.map((item) => {
      const value = meaningfulNumber(readFacilityValue(facilities, item.aliases));
      return value == null ? null : { ...item, value: Math.round(value).toLocaleString("en-AU") };
    }).filter(Boolean);
  }

  function normaliseFeatureFallback(raw) {
    const source = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const items = [];
    source.forEach((entry) => {
      if (entry && typeof entry === "object") {
        const name = String(entry.name || entry.label || "").trim();
        const description = String(entry.description || "").trim();
        if (name) items.push({ name, description });
        return;
      }
      const text = String(entry == null ? "" : entry).trim();
      if (text) items.push({ name: text, description: "" });
    });
    return items;
  }

  function exclusiveAreas(ship) {
    const facilities = ship?.facilities || {};
    const raw = readFacilityValue(facilities, ["exclusive_areas", "exclusiveAreas", "exclusive"]);
    const api = global.CiShipFacilities;
    return api?.normalizeExclusiveAreasForDisplay ? api.normalizeExclusiveAreasForDisplay(raw) : normaliseFeatureFallback(raw);
  }

  function specialtyFeatures(ship) {
    const facilities = ship?.facilities || {};
    const raw = readFacilityValue(facilities, ["specialty_features", "specialtyFeatures", "signature_features"]);
    const api = global.CiShipFacilities;
    return api?.normalizeSpecialtyFeaturesForDisplay ? api.normalizeSpecialtyFeaturesForDisplay(raw) : normaliseFeatureFallback(raw);
  }

  function featureName(item) {
    if (typeof item === "string") return item.trim();
    return String(item?.name || item?.label || "").trim();
  }

  function featureDescription(item) {
    return item && typeof item === "object" ? String(item.description || "").trim() : "";
  }

  function roomBreakdown(ship) {
    const reconcile = global.CiStateroomReconciliation;
    if (!reconcile?.reconcileStateroomDisplay) return null;
    const result = reconcile.reconcileStateroomDisplay({
      stateroomCount: ship?.stateroom_count,
      stateroomBreakdown: ship?.stateroom_breakdown,
      legacyBreakdown: ship?.cabin_type_summary || null
    });
    if (!result?.canRenderDonut || !Array.isArray(result.renderedCategories) || !result.renderedCategories.length) return null;
    const total = result.renderedCategories.reduce((sum, item) => sum + Number(item.count || 0), 0);
    if (!total) return null;
    const categories = result.renderedCategories.map((item, index) => ({
      label: String(item.label || `Room type ${index + 1}`),
      count: Number(item.count || 0),
      sqm: item.sqm,
      color: ROOM_COLORS[index % ROOM_COLORS.length]
    })).filter((item) => item.count > 0);
    if (!categories.length) return null;
    return {
      ...result,
      total,
      categories,
      centreTotal: result.centreMode === "total" && result.authoritativeTotal != null ? Number(result.authoritativeTotal) : null
    };
  }

  function buildRoomChartSvg(ship) {
    const breakdown = roomBreakdown(ship);
    if (!breakdown) return null;
    // The Mailchimp asset pipeline rasterises this SVG. Keep the generated image
    // deliberately text-free so server font availability can never turn labels
    // into missing-glyph boxes. All room labels/counts are rendered as HTML below.
    const width = 560;
    const height = 180;
    const cx = 280;
    const cy = 90;
    const r = 60;
    const stroke = 28;
    const circumference = 2 * Math.PI * r;
    let offset = 0;
    const arcs = breakdown.categories.map((item) => {
      const length = (item.count / breakdown.total) * circumference;
      const svg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${item.color}" stroke-width="${stroke}" stroke-dasharray="${length.toFixed(3)} ${(circumference - length).toFixed(3)}" stroke-dashoffset="${(-offset).toFixed(3)}" transform="rotate(-90 ${cx} ${cy})"/>`;
      offset += length;
      return svg;
    }).join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" data-email-donut-v2="1" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" rx="8" fill="#FFFFFF"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#EEF1F0" stroke-width="${stroke}"/>${arcs}<circle cx="${cx}" cy="${cy}" r="44" fill="#FFFFFF"/></svg>`;
    let dataUrl = "";
    try {
      dataUrl = `data:image/svg+xml;base64,${global.btoa(unescape(encodeURIComponent(svg)))}`;
    } catch (_error) {
      dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    }
    const alt = `Room types: ${breakdown.categories.map((item) => `${item.label} ${item.count.toLocaleString("en-AU")}`).join(", ")}`;
    return { svg, dataUrl, alt, breakdown };
  }

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
      db.from("ci_cruise_ships").select("id,cruise_line_id,name,slug,status,ship_class,year_built,year_refurbished,passenger_capacity,crew_count,deck_count,stateroom_count,stateroom_breakdown,cabin_type_summary,gross_tonnage,length_metres,beam_metres,cruising_speed_knots,facilities,hero_image_url,image_gallery,active").eq("active", true).order("name"),
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

  function iconSvg(svg, size = 24) {
    if (!svg) return "";
    return svg.replace("<svg ", `<svg width="${size}" height="${size}" aria-hidden="true" style="display:block;margin:0 auto;color:${BRAND_DARK_GREEN};" `);
  }

  function renderSummaryStatCell(item) {
    return `<td class="cr101-ss-summary-cell" width="20%" valign="top" align="center" style="width:20%;padding:12px 4px;vertical-align:top;text-align:center;">
      <div style="height:26px;line-height:26px;color:${BRAND_DARK_GREEN};">${iconSvg(MY_SHIP_SUMMARY_ICONS[item.key], 24)}</div>
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:17px;font-weight:700;line-height:22px;color:${BODY};margin-top:5px;">${esc(item.value)}</div>
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:9px;font-weight:700;line-height:13px;letter-spacing:.65px;text-transform:uppercase;color:${MUTED};margin-top:2px;">${esc(item.label)}</div>
    </td>`;
  }

  function renderSummaryGrid(items) {
    if (!items.length) return "";
    return `<tr><td align="center" style="padding:30px 0 0;"><div style="font-family:Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${BRAND_DARK_GREEN};text-align:center;margin-bottom:12px;">SHIP AT A GLANCE</div><table role="presentation" class="cr101-ss-summary-grid" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;border-top:1px solid ${DIVIDER};border-bottom:1px solid ${DIVIDER};"><tr>${items.map(renderSummaryStatCell).join("")}</tr></table></td></tr>`;
  }

  function renderTechnicalDetails(items) {
    if (!items.length) return "";
    const cells = items.map((item) => `<td class="cr101-ss-detail-cell" width="20%" valign="top" align="center" style="width:20%;padding:9px 4px;vertical-align:top;text-align:center;"><div style="font-family:Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;line-height:18px;color:${BODY};">${esc(item.value)}</div><div style="font-family:Helvetica,Arial,sans-serif;font-size:8.5px;font-weight:700;line-height:12px;letter-spacing:.45px;text-transform:uppercase;color:${MUTED};margin-top:2px;">${esc(item.label)}</div></td>`).join("");
    return `<tr><td align="center" style="padding:8px 0 0;"><table role="presentation" class="cr101-ss-detail-grid" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;background:#FFFFFF;">${cells ? `<tr>${cells}</tr>` : ""}</table></td></tr>`;
  }

  function renderOnboardCell(item) {
    return `<td class="cr101-ss-onboard-cell" width="20%" valign="top" align="center" style="width:20%;padding:10px 5px;vertical-align:top;text-align:center;">
      <div style="height:27px;line-height:27px;color:${BRAND_DARK_GREEN};">${iconSvg(MY_SHIP_GLANCE_ICONS[item.key], 25)}</div>
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:18px;font-weight:700;line-height:22px;color:${BODY};margin-top:4px;">${esc(item.value)}</div>
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:9px;font-weight:700;line-height:13px;letter-spacing:.35px;text-transform:uppercase;color:${BRAND_DARK_GREEN};margin-top:2px;">${esc(item.label)}</div>
    </td>`;
  }

  function renderOnboardGrid(items) {
    if (!items.length) return "";
    return `<tr><td align="center" style="padding:30px 0 0;"><div style="font-family:Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${BRAND_DARK_GREEN};text-align:center;margin-bottom:10px;">ON BOARD</div><table role="presentation" class="cr101-ss-onboard-grid" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;border:1px solid ${BRAND_GREEN};background:#FFFFFF;"><tr>${items.map(renderOnboardCell).join("")}</tr></table></td></tr>`;
  }

  function renderRoomTypes(ship) {
    const chart = buildRoomChartSvg(ship);
    if (!chart) return "";
    const legendRows = chart.breakdown.categories.map((item) => {
      const pct = Math.round((item.count / chart.breakdown.total) * 100);
      const count = item.count.toLocaleString("en-AU");
      return `<tr><td width="24" valign="middle" style="width:24px;padding:5px 0;vertical-align:middle;"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${item.color};"></span></td><td valign="middle" style="padding:5px 8px 5px 0;font-family:Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;line-height:1.35;color:#111111;vertical-align:middle;">${esc(item.label)}</td><td width="120" align="right" valign="middle" style="width:120px;padding:5px 0;font-family:Helvetica,Arial,sans-serif;font-size:11px;font-weight:400;line-height:1.35;color:#545454;text-align:right;vertical-align:middle;">${esc(count)} · ${pct}%</td></tr>`;
    }).join("");
    const totalRow = chart.breakdown.centreTotal != null
      ? `<tr><td colspan="3" align="center" style="padding:3px 0 8px;font-family:Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;line-height:1.35;color:#545454;text-align:center;">${esc(chart.breakdown.centreTotal.toLocaleString("en-AU"))} STATEROOMS</td></tr>`
      : "";
    return `<tr><td align="center" style="padding:30px 0 0;"><div style="font-family:Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${BRAND_DARK_GREEN};text-align:center;margin-bottom:10px;">ROOM TYPES</div><img class="cr101-ss-room-chart" src="${esc(chart.dataUrl)}" alt="${esc(chart.alt)}" width="560" border="0" style="display:block;width:100%;max-width:560px;height:auto;border:0;margin:0 auto;"><table role="presentation" class="cr101-ss-room-legend" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:460px;border-collapse:collapse;margin:6px auto 0;background:#FFFFFF;">${totalRow}${legendRows}</table></td></tr>`;
  }

  function renderFeatureList(title, items) {
    const valid = (items || []).filter((item) => featureName(item));
    if (!valid.length) return "";
    const rows = valid.map((item) => {
      const name = featureName(item);
      const description = featureDescription(item);
      return `<tr><td width="15" valign="top" style="width:15px;padding:5px 5px 5px 0;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:${BRAND_DARK_GREEN};">•</td><td valign="top" style="padding:5px 0;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:${BODY};"><strong style="font-weight:700;">${esc(name)}</strong>${description ? `<div style="font-size:11px;line-height:16px;color:${MUTED};margin-top:2px;">${esc(description)}</div>` : ""}</td></tr>`;
    }).join("");
    return `<td class="cr101-ss-feature-col" width="50%" valign="top" style="width:50%;padding:16px 18px;vertical-align:top;border:1px solid ${DIVIDER};background:#FFFFFF;"><div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;color:${BRAND_DARK_GREEN};margin-bottom:7px;">${esc(title)}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">${rows}</table></td>`;
  }

  function renderFeatures(ship) {
    const exclusive = exclusiveAreas(ship);
    const specialty = specialtyFeatures(ship);
    if (!exclusive.length && !specialty.length) return "";
    return `<tr><td align="center" style="padding:24px 0 0;"><table role="presentation" class="cr101-ss-features" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;"><tr>${exclusive.length ? renderFeatureList("Exclusive Areas", exclusive) : '<td class="cr101-ss-feature-col" width="50%" style="width:50%;"></td>'}${specialty.length ? renderFeatureList("Specialty Features", specialty) : '<td class="cr101-ss-feature-col" width="50%" style="width:50%;"></td>'}</tr></table></td></tr>`;
  }

  function renderLineIdentity(line) {
    const logo = String(line?.logo_url || "").trim();
    if (/^https:\/\//i.test(logo)) {
      return `<tr><td align="center" style="padding:0 0 20px;"><img src="${esc(logo)}" alt="${esc(line?.name || "Cruise line")}" width="170" border="0" style="display:block;width:auto;max-width:170px;max-height:48px;height:auto;border:0;margin:0 auto;"></td></tr>`;
    }
    return line?.name ? `<tr><td align="center" style="font-family:Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#000000;text-align:center;padding:0 0 20px;">${esc(line.name)}</td></tr>` : "";
  }

  function emailStyleBlock() {
    return `<style type="text/css">
      @media only screen and (max-width:620px) {
        .cr101-ss-wrapper { width:100% !important; }
        .cr101-ss-summary-cell,.cr101-ss-detail-cell,.cr101-ss-onboard-cell { display:inline-block !important;width:50% !important;max-width:50% !important;box-sizing:border-box !important;padding:12px 5px !important; }
        .cr101-ss-feature-col { display:block !important;width:100% !important;max-width:100% !important;box-sizing:border-box !important;border-left:1px solid ${DIVIDER} !important;border-right:1px solid ${DIVIDER} !important; }
        .cr101-ss-room-chart { width:100% !important;height:auto !important; }
      }
    </style>`;
  }

  function emailHtml() {
    capture();
    const ship = currentShip(); const line = currentLine();
    if (!ship || !draft || !draft.hero_image_url) return "";
    const summary = summaryStats(ship);
    const details = technicalDetailStats(ship);
    const onboard = onboardStats(ship);
    const intro = String(draft.editorial_intro || "").trim();
    const ctaUrl = publicUrl();
    const cta = ctaUrl ? `<tr><td align="center" style="padding:40px 0 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="border-collapse:collapse;"><tr><td align="center" bgcolor="#000000" style="background-color:#000000;border-radius:2px;"><a href="${esc(ctaUrl)}" target="_blank" style="font-family:Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#FFFFFF;text-decoration:none;display:inline-block;padding:14px 32px;">EXPLORE ${esc(ship.name.toUpperCase())} →</a></td></tr></table></td></tr>` : "";

    return `${emailStyleBlock()}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE_BG}" style="width:100%;border-collapse:collapse;background-color:${PAGE_BG};"><tr><td align="center" bgcolor="${PAGE_BG}" style="padding:0;background-color:${PAGE_BG};"><table role="presentation" class="cr101-ss-wrapper" width="${MAX_WIDTH}" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE_BG}" style="width:100%;max-width:${MAX_WIDTH}px;border-collapse:collapse;background-color:${PAGE_BG};"><tr><td align="center" style="padding:24px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
<tr><td align="center" style="font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:400;letter-spacing:3px;text-transform:uppercase;color:${MUTED};text-align:center;padding:0 0 18px;">${esc(draft.eyebrow || "SHIP SPOTLIGHT")}</td></tr>
<tr><td align="center" style="font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:700;line-height:1.3;color:#000000;text-align:center;padding:0 12px 10px;">${esc(draft.newsletter_heading || ship.name)}</td></tr>
${renderLineIdentity(line)}
<tr><td align="center" style="padding:0;"><img src="${esc(draft.hero_image_url)}" alt="${esc(ship.name)}" width="${MAX_WIDTH}" border="0" style="display:block;width:100%;max-width:${MAX_WIDTH}px;height:auto;border:0;"></td></tr>
${intro ? `<tr><td align="center" style="padding:24px 16px 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:400;color:${BODY};text-align:center;line-height:1.65;">${esc(intro)}</td></tr>` : ""}
${renderRoomTypes(ship)}
${renderSummaryGrid(summary)}
${renderTechnicalDetails(details)}
${renderOnboardGrid(onboard)}
${renderFeatures(ship)}
${cta}
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

  function emailAssetsForCurrentShip() {
    const ship = currentShip();
    const line = currentLine();
    if (!ship || !draft) return [];
    const assets = [];
    const hero = String(draft.hero_image_url || "").trim();
    if (!/^https:\/\//i.test(hero)) throw new Error("The hero image must have an absolute https address before the newsletter block can be copied.");
    assets.push({
      raw_url: hero,
      request: { source_url: hero, asset_type: "hero", label: ship.name || "ship" }
    });
    const logo = String(line?.logo_url || "").trim();
    if (/^https:\/\//i.test(logo)) {
      assets.push({
        raw_url: logo,
        request: { source_url: logo, asset_type: "route_map", label: `${line?.name || "cruise line"} logo` }
      });
    }
    const roomChart = buildRoomChartSvg(ship);
    if (roomChart) {
      assets.push({
        raw_url: roomChart.dataUrl,
        request: {
          source_url: `https://101cruise.com.au/generated/ship-spotlight-room-chart/${encodeURIComponent(slugify(ship.name))}.svg`,
          inline_svg: roomChart.svg,
          asset_type: "route_map",
          label: `${ship.name || "ship"} room types`
        }
      });
    }
    return assets;
  }

  async function prepareHostedHtml() {
    const saved = await save({ quiet: true }); if (!saved) return "";
    let html = emailHtml();
    const assets = emailAssetsForCurrentShip();
    if (!assets.length) return html;
    message = `Preparing Ship Spotlight images 1 of ${assets.length}…`; messageTone = ""; busy = true; render();
    const headers = typeof global.adminAuthHeaders === "function" ? await global.adminAuthHeaders({ "Content-Type": "application/json" }) : { "Content-Type": "application/json" };
    for (let i = 0; i < assets.length; i += 1) {
      message = `Preparing Ship Spotlight images ${i + 1} of ${assets.length}…`; render();
      const asset = assets[i];
      const response = await fetch(EMAIL_ASSET_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify({ spotlight_id: draft.id, asset_index: i + 1, asset_total: assets.length, assets: [asset.request] })
      });
      const data = await response.json().catch(() => ({}));
      const hostedUrl = data.mappings?.[0]?.mailchimp_file_url;
      if (!response.ok || data.success === false || !hostedUrl) throw new Error(data.error || "Could not prepare a Ship Spotlight image.");
      html = html.split(asset.raw_url).join(hostedUrl);
    }
    return html;
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
  function useMediaLibrary() {
    close();
    const candidates = Array.from(document.querySelectorAll("button,a"));
    const target = candidates.find((el) => /media library/i.test(String(el.textContent || "").trim()));
    if (target && typeof target.click === "function") target.click();
  }

  function renderPreview() {
    if (!previewOpen || !draft) return "";
    return `<div class="ss-preview-backdrop" onclick="if(event.target===this) ShipSpotlightAdmin.closePreview()"><div class="ss-preview-modal"><div class="ss-preview-head"><div><strong>Newsletter block preview</strong><div class="admin-small">600px email canvas. Resize the browser to inspect mobile stacking.</div></div><button class="admin-button secondary small" onclick="ShipSpotlightAdmin.closePreview()">Close</button></div><div class="ss-preview-canvas">${emailHtml()}</div></div></div>`;
  }

  function adminStatCards(ship) {
    const items = [...technicalStats(ship), ...onboardStats(ship)];
    return items.length ? items.map((item) => `<div class="ss-auto-stat"><strong>${esc(item.value)}</strong><span>${esc(item.label)}</span></div>`).join("") : '<p class="admin-muted">No populated ship statistics are available yet.</p>';
  }

  function adminRoomSummary(ship) {
    const room = roomBreakdown(ship);
    if (!room) return '<p class="admin-muted">No reconciled room-type breakdown is available for this ship.</p>';
    return `<div class="ss-room-summary">${room.categories.map((item) => `<span><i style="background:${esc(item.color)}"></i><strong>${esc(item.label)}</strong> ${esc(item.count.toLocaleString("en-AU"))}</span>`).join("")}</div>`;
  }

  function adminFeatureSummary(ship) {
    const exclusive = exclusiveAreas(ship).map(featureName).filter(Boolean);
    const specialty = specialtyFeatures(ship).map(featureName).filter(Boolean);
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
      <section><h3>Newsletter presentation</h3><p class="admin-muted">The ship name is followed by the cruise-line logo, then the hero image and your description. The layout uses the same 600px newsletter canvas and remains separate from Cruise Specials.</p><div class="ss-grid two"><div class="admin-field"><label>Eyebrow</label><input id="ssEyebrow" value="${esc(draft.eyebrow)}"></div><div class="admin-field"><label>Heading</label><input id="ssHeading" value="${esc(draft.newsletter_heading)}"></div></div><div class="admin-field"><label>Short introduction</label><textarea id="ssIntro" rows="4" placeholder="40–60 words works best in the newsletter.">${esc(draft.editorial_intro)}</textarea></div></section>
      <section><h3>Room types</h3><p class="admin-muted">Automatic. Uses the same reconciled stateroom breakdown and category order as My Cruise → My Ship. The donut is converted to a static Mailchimp-hosted image when you copy the block.</p>${adminRoomSummary(ship)}</section>
      <section><h3>Ship statistics</h3><p class="admin-muted">Automatic. The main cards use the actual My Ship icons. Other populated ship specifications are shown without invented icons.</p><div class="ss-auto-stat-grid">${adminStatCards(ship)}</div></section>
      <section><h3>Areas & features</h3><p class="admin-muted">Pulled directly from the ship record using the same feature normalisation as My Ship. Object-based features are displayed by name, not as [object Object].</p>${adminFeatureSummary(ship)}</section>
      <section><div class="ss-section-head"><div><h3>Hero image</h3><p class="admin-muted">The hero, cruise-line logo and room chart are prepared through the Ship Spotlight Mailchimp image pipeline before the block is copied.</p></div><button class="admin-button secondary small" onclick="ShipSpotlightAdmin.useMediaLibrary()">Open Media Library</button></div><div class="admin-field"><label>Hero image</label><select id="ssHero" onchange="ShipSpotlightAdmin.capture(); ShipSpotlightAdmin.render()"><option value="">Select image</option>${heroOptions}</select></div></section>
      <section><h3>Public ship page</h3><div class="ss-grid two"><div class="admin-field"><label>Public slug</label><input id="ssSlug" value="${esc(draft.public_slug)}"></div><label class="ss-publish"><input id="ssPublished" type="checkbox" ${draft.publication_status === "published" ? "checked" : ""}> Publish this Ship Spotlight page</label></div><div class="admin-helper">${esc(publicUrl())}</div></section>
      <div class="ss-actions"><button class="admin-button secondary" onclick="ShipSpotlightAdmin.openPreview()">Preview Newsletter Block</button><button class="admin-button secondary" onclick="ShipSpotlightAdmin.save()" ${busy ? "disabled" : ""}>Save Spotlight</button><button class="admin-button black" onclick="ShipSpotlightAdmin.${hostedHtmlCache ? "copyAgainIfReady" : "copyNewsletterBlock"}()" ${busy ? "disabled" : ""}>${busy ? "Preparing…" : "Copy Newsletter Block"}</button></div></div>`;
  }

  function styles() {
    if (document.getElementById("shipSpotlightStyles")) return;
    const el = document.createElement("style"); el.id = "shipSpotlightStyles";
    el.textContent = `.ss-nav-btn{display:block;width:100%;border:0;background:transparent;text-align:left;padding:9px 14px 9px 28px;font:inherit;color:inherit;cursor:pointer}.ss-nav-btn:hover{background:rgba(0,0,0,.05)}.ss-overlay{position:fixed;inset:0;z-index:9998;background:#f4f5f6;overflow:auto}.ss-shell{max-width:1180px;margin:0 auto;padding:22px}.ss-top{display:flex;gap:16px;justify-content:space-between;align-items:flex-start;margin-bottom:16px}.ss-top h1{margin:2px 0 5px}.ss-top-actions{display:flex;gap:8px;align-items:center}.ss-card{background:#fff;border:1px solid #e3e6e8;border-radius:12px;padding:20px;box-shadow:0 8px 28px rgba(20,30,40,.05)}.ss-selector{display:flex;gap:12px;align-items:end;margin-bottom:16px}.ss-selector .admin-field{flex:1;margin:0}.ss-form section{padding:20px 0;border-top:1px solid #e8ebed}.ss-form section:first-of-type{border-top:0}.ss-form h3{margin:0 0 8px}.ss-form h4{margin:0 0 7px}.ss-grid{display:grid;gap:12px}.ss-grid.two{grid-template-columns:repeat(2,minmax(0,1fr))}.ss-identity{display:grid;grid-template-columns:150px 1fr;gap:18px;align-items:center;padding-bottom:20px}.ss-identity img{width:150px;height:95px;object-fit:cover;border-radius:9px}.ss-identity h2{margin:0 0 5px}.ss-section-head{display:flex;justify-content:space-between;gap:12px;align-items:start}.ss-auto-stat-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin-top:12px}.ss-auto-stat{border:1px solid #dfe3e6;border-radius:8px;padding:11px 8px;text-align:center;background:#fff}.ss-auto-stat strong{display:block;font-size:16px;color:#111}.ss-auto-stat span{display:block;margin-top:3px;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#66727c}.ss-room-summary{display:flex;flex-wrap:wrap;gap:8px 14px}.ss-room-summary span{font-size:12px;color:#48525a;display:flex;align-items:center;gap:5px}.ss-room-summary i{display:inline-block;width:10px;height:10px;border-radius:2px}.ss-publish{display:flex;align-items:center;gap:8px;padding-top:27px}.ss-actions{display:flex;justify-content:flex-end;gap:8px;padding-top:18px}.ss-message{margin:0 0 14px;padding:10px 12px;border-radius:8px;background:#eef2f4}.ss-message.success{background:#e9f7ef;color:#17633f}.ss-message.error{background:#fff0f0;color:#9a2525}.ss-preview-backdrop{position:fixed;inset:0;z-index:9999;background:rgba(20,25,30,.75);overflow:auto;padding:30px}.ss-preview-modal{max-width:760px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden}.ss-preview-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid #e4e7e9}.ss-preview-canvas{background:#f7f7f7;padding:18px}@media(max-width:900px){.ss-auto-stat-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:760px){.ss-grid.two{grid-template-columns:1fr}.ss-auto-stat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.ss-top{display:block}.ss-top-actions{margin-top:10px}.ss-identity{grid-template-columns:1fr}.ss-selector{display:block}.ss-selector .admin-field{margin-bottom:8px}.ss-section-head{display:block}.ss-section-head .admin-button{margin-top:8px}}`;
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

  global.ShipSpotlightAdmin = { open, close, ensureLoaded, selectShip, render, capture, save, openPreview, closePreview, copyNewsletterBlock, copyAgainIfReady, useMediaLibrary, emailHtml, buildRoomChartSvg };
})(window);
