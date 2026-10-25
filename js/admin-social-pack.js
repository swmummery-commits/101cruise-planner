/**
 * Newsletter Issue Composer — Create Social Pack modal (approved three-card pack).
 */
(function (global) {
  "use strict";

  let open = false;
  let busy = false;
  let issueNumber = null;
  let panelIssueNumber = null;
  let cruises = [];
  let previewId = null;
  let preview = null;
  let message = "";
  let messageTone = "";
  let treatment = "soft";
  let packTemplate = "classic";
  let routeMapStyle = "classic";
  let savingsDisplay = "percentage";
  let savingsAvailable = false;
  let socialMediaId = null;
  let imagePickerOpen = false;
  let imagePickerTab = "recommended";
  /** @type {Record<string, string[]>} room_label lists keyed by cruise id */
  let roomSelections = {};
  /** @type {Record<string, Array<{id:string}>>} full image pools for Next/Previous */
  let candidateCache = {};
  let lastDownloadUrl = null;
  let packTemplateChosen = false;

  const PACK_TEMPLATES = [
    ["classic", "Classic"],
    ["premium_dark", "Premium Dark"],
    ["route_deal", "Route Deal"],
    ["price_shock", "Price Shock"],
    ["destination_journey", "Destination Journey"],
    ["ship_journey", "Ship + Journey"]
  ];

  const TEMPLATE_DEMOS = {
    classic: {
      title: "Classic",
      note: "Photo poster with destination, ship, and room prices.",
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 400" role="img" aria-hidden="true"><rect width="320" height="400" fill="#1a3b4a"/><rect width="320" height="210" fill="#4aa3b5"/><circle cx="250" cy="58" r="28" fill="#f3d9a4" opacity=".85"/><rect x="0" y="168" width="320" height="42" fill="#071018" opacity=".28"/><text x="20" y="196" fill="#fff" font-family="Helvetica,Arial,sans-serif" font-size="22" font-weight="800">Mediterranean</text><rect x="0" y="210" width="320" height="190" fill="#f6f3ec"/><text x="20" y="244" fill="#12181d" font-family="Helvetica,Arial,sans-serif" font-size="16" font-weight="800">Oceania Marina</text><text x="20" y="268" fill="#5e6b74" font-family="Helvetica,Arial,sans-serif" font-size="11">Barcelona  ·  Rome  ·  10 nights</text><rect x="20" y="286" width="86" height="46" rx="6" fill="#fff" stroke="#d7ddd8"/><rect x="114" y="286" width="86" height="46" rx="6" fill="#fff" stroke="#d7ddd8"/><text x="28" y="306" fill="#5e6b74" font-family="Helvetica,Arial,sans-serif" font-size="8" font-weight="700">INSIDE</text><text x="28" y="324" fill="#12181d" font-family="Helvetica,Arial,sans-serif" font-size="13" font-weight="800">$2,180</text><text x="122" y="306" fill="#5e6b74" font-family="Helvetica,Arial,sans-serif" font-size="8" font-weight="700">BALCONY</text><text x="122" y="324" fill="#12181d" font-family="Helvetica,Arial,sans-serif" font-size="13" font-weight="800">$2,860</text><rect x="0" y="384" width="320" height="16" fill="#8dd9bf"/><text x="20" y="373" fill="#245c4e" font-family="Helvetica,Arial,sans-serif" font-size="10" font-weight="800">101CRUISE.COM.AU</text></svg>`
    },
    premium_dark: {
      title: "Premium Dark",
      note: "Dark cinematic poster with a large route and fare.",
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 400" role="img" aria-hidden="true"><rect width="320" height="400" fill="#0b1220"/><rect width="320" height="400" fill="#173246" opacity=".35"/><text x="20" y="36" fill="#8dd9bf" font-family="Helvetica,Arial,sans-serif" font-size="11" font-weight="800">101CRUISE</text><text x="20" y="118" fill="#fff" font-family="Georgia,'Times New Roman',serif" font-size="28" font-weight="800">ROME</text><text x="20" y="154" fill="#8dd9bf" font-family="Helvetica,Arial,sans-serif" font-size="16" font-weight="700">→ BARCELONA</text><text x="20" y="186" fill="#c8cdd4" font-family="Helvetica,Arial,sans-serif" font-size="12">Oceania Sirena  ·  11 nights</text><rect x="20" y="210" width="280" height="1" fill="#dde2e8" opacity=".25"/><text x="20" y="236" fill="#fff" font-family="Helvetica,Arial,sans-serif" font-size="12">Civitavecchia</text><text x="20" y="256" fill="#fff" font-family="Helvetica,Arial,sans-serif" font-size="12">Cagliari</text><text x="20" y="276" fill="#fff" font-family="Helvetica,Arial,sans-serif" font-size="12">Malaga</text><rect x="20" y="300" width="160" height="44" rx="4" fill="#111827" stroke="#8dd9bf"/><text x="32" y="318" fill="#8dd9bf" font-family="Helvetica,Arial,sans-serif" font-size="8" font-weight="700">AIRLINE STAFF FARE</text><text x="32" y="336" fill="#fff" font-family="Helvetica,Arial,sans-serif" font-size="16" font-weight="800">$2,480</text><rect x="0" y="384" width="320" height="16" fill="#8dd9bf"/></svg>`
    },
    route_deal: {
      title: "Route Deal",
      note: "Map-led square fare graphic.",
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320" role="img" aria-hidden="true"><rect width="320" height="320" fill="#fff"/><rect width="320" height="168" fill="#d7ebe4"/><circle cx="58" cy="72" r="6" fill="#173246"/><circle cx="168" cy="46" r="6" fill="#173246"/><circle cx="248" cy="92" r="6" fill="#173246"/><path d="M58 72 C110 40 150 38 168 46 C200 58 220 86 248 92" fill="none" stroke="#173246" stroke-width="3"/><rect x="16" y="128" width="110" height="22" rx="11" fill="#173246"/><text x="71" y="143" text-anchor="middle" fill="#fff" font-family="Helvetica,Arial,sans-serif" font-size="8" font-weight="700">PRINCESS</text><rect x="228" y="12" width="80" height="24" rx="12" fill="#173246"/><text x="268" y="28" text-anchor="middle" fill="#fff" font-family="Helvetica,Arial,sans-serif" font-size="9" font-weight="800">SAVE 28%</text><text x="20" y="200" fill="#12181d" font-family="Helvetica,Arial,sans-serif" font-size="20" font-weight="800">Sapphire Princess</text><text x="20" y="222" fill="#243140" font-family="Helvetica,Arial,sans-serif" font-size="12" font-weight="600">Honolulu  →  Vancouver</text><text x="20" y="242" fill="#5e6b74" font-family="Helvetica,Arial,sans-serif" font-size="10">12 May 2026   |   15 nights</text><text x="20" y="276" fill="#173246" font-family="Helvetica,Arial,sans-serif" font-size="26" font-weight="800">$2,280</text><text x="20" y="294" fill="#5e6b74" font-family="Helvetica,Arial,sans-serif" font-size="9">from</text><rect x="0" y="310" width="320" height="10" fill="#8dd9bf"/></svg>`
    },
    price_shock: {
      title: "Price Shock",
      note: "Dark square with a large staff fare.",
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320" role="img" aria-hidden="true"><rect width="320" height="320" fill="#12181d"/><text x="20" y="36" fill="#8dd9bf" font-family="Helvetica,Arial,sans-serif" font-size="12" font-weight="800">101CRUISE</text><text x="300" y="36" text-anchor="end" fill="#c5ced4" font-family="Helvetica,Arial,sans-serif" font-size="9">Princess  ·  Sapphire</text><text x="160" y="118" text-anchor="middle" fill="#8dd9bf" font-family="Helvetica,Arial,sans-serif" font-size="11" font-weight="700" letter-spacing="2">AIRLINE STAFF FARE</text><text x="160" y="176" text-anchor="middle" fill="#fff" font-family="Helvetica,Arial,sans-serif" font-size="46" font-weight="800">$1,890</text><line x1="118" y1="198" x2="202" y2="198" stroke="#9aa6ae" stroke-width="2"/><text x="160" y="204" text-anchor="middle" fill="#9aa6ae" font-family="Helvetica,Arial,sans-serif" font-size="14">$2,860</text><rect x="118" y="218" width="84" height="24" rx="12" fill="#f80020"/><text x="160" y="234" text-anchor="middle" fill="#fff" font-family="Helvetica,Arial,sans-serif" font-size="10" font-weight="800">SAVE 34%</text><text x="20" y="276" fill="#8dd9bf" font-family="Helvetica,Arial,sans-serif" font-size="10" font-weight="700">HONOLULU  →  VANCOUVER</text><text x="20" y="296" fill="#fff" font-family="Helvetica,Arial,sans-serif" font-size="11">Honolulu  ·  Juneau  ·  Vancouver</text><rect x="0" y="310" width="320" height="10" fill="#8dd9bf"/></svg>`
    },
    destination_journey: {
      title: "Destination Journey",
      note: "Destination photo with the fare overlaid.",
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320" role="img" aria-hidden="true"><defs><linearGradient id="djDemo" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4aa3b5"/><stop offset=".45" stop-color="#1d4d5c"/><stop offset="1" stop-color="#081018"/></linearGradient></defs><rect width="320" height="320" fill="url(#djDemo)"/><circle cx="240" cy="70" r="36" fill="#f3d9a4" opacity=".55"/><text x="20" y="36" fill="#fff" font-family="Helvetica,Arial,sans-serif" font-size="11" font-weight="800">101CRUISE</text><text x="20" y="188" fill="#fff" font-family="Helvetica,Arial,sans-serif" font-size="24" font-weight="800">Hawaii</text><text x="20" y="212" fill="#f4f7f8" font-family="Helvetica,Arial,sans-serif" font-size="12">Honolulu  ·  Maui  ·  Kauai</text><text x="20" y="248" fill="#8dd9bf" font-family="Helvetica,Arial,sans-serif" font-size="9" font-weight="700" letter-spacing="1.2">AIRLINE STAFF FARE</text><text x="20" y="284" fill="#fff" font-family="Helvetica,Arial,sans-serif" font-size="28" font-weight="800">$2,280</text><rect x="216" y="248" width="84" height="24" rx="12" fill="#f80020"/><text x="258" y="264" text-anchor="middle" fill="#fff" font-family="Helvetica,Arial,sans-serif" font-size="10" font-weight="800">SAVE 22%</text><rect x="0" y="310" width="320" height="10" fill="#8dd9bf"/></svg>`
    },
    ship_journey: {
      title: "Ship + Journey",
      note: "Ship photo, route map, and fare.",
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320" role="img" aria-hidden="true"><rect width="320" height="320" fill="#f6f3ec"/><rect width="320" height="112" fill="#395a68"/><rect x="40" y="48" width="240" height="38" rx="18" fill="#d9e4e8"/><text x="20" y="28" fill="#fff" font-family="Helvetica,Arial,sans-serif" font-size="11" font-weight="800">101CRUISE</text><text x="20" y="140" fill="#12181d" font-family="Helvetica,Arial,sans-serif" font-size="18" font-weight="800">Marina</text><text x="20" y="158" fill="#5e6b74" font-family="Helvetica,Arial,sans-serif" font-size="11">Oceania Cruises</text><rect x="20" y="172" width="280" height="58" rx="8" fill="#d7ebe4"/><circle cx="70" cy="201" r="5" fill="#173246"/><circle cx="160" cy="190" r="5" fill="#173246"/><circle cx="250" cy="206" r="5" fill="#173246"/><path d="M70 201 C110 176 140 176 160 190 C200 210 220 212 250 206" fill="none" stroke="#173246" stroke-width="2.5"/><text x="20" y="250" fill="#12181d" font-family="Helvetica,Arial,sans-serif" font-size="11">Barcelona  ·  Palma  ·  Rome</text><text x="20" y="278" fill="#5e6b74" font-family="Helvetica,Arial,sans-serif" font-size="8" font-weight="700" letter-spacing="1">AIRLINE STAFF FARE</text><text x="20" y="302" fill="#12181d" font-family="Helvetica,Arial,sans-serif" font-size="22" font-weight="800">$2,480</text><rect x="216" y="274" width="84" height="24" rx="12" fill="#f80020"/><text x="258" y="290" text-anchor="middle" fill="#fff" font-family="Helvetica,Arial,sans-serif" font-size="10" font-weight="800">SAVE 19%</text><rect x="0" y="310" width="320" height="10" fill="#8dd9bf"/></svg>`
    }
  };

  function templateHasMap(value) {
    return value === "route_deal" || value === "ship_journey";
  }

  function templateShowsSavings(value) {
    return ["route_deal", "price_shock", "destination_journey", "ship_journey"].includes(value);
  }

  function packRequestFields() {
    return {
      treatment,
      template: packTemplate,
      route_map_style: routeMapStyle,
      savings_display: savingsDisplay
    };
  }

  function ensureTemplateChosen() {
    if (packTemplateChosen) return true;
    message = "Choose a Social Pack template before generating previews.";
    messageTone = "error";
    rerender();
    return false;
  }

  function esc(value) {
    return typeof global.esc === "function"
      ? global.esc(value)
      : String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");
  }

  async function authHeaders() {
    if (typeof global.adminAuthHeaders === "function") return global.adminAuthHeaders();
    throw new Error("Admin authentication is not available.");
  }

  function selectedIds() {
    return cruises.filter((c) => c.selected && c.readiness?.status !== "blocked").map((c) => c.id);
  }

  function selectedReady() {
    return cruises.filter((c) => c.selected && c.readiness?.status !== "blocked");
  }

  function cruiseRooms(cruise) {
    return Array.isArray(cruise?.offers) ? cruise.offers : [];
  }

  function ensureRoomDefaults(cruise) {
    if (!cruise?.id) return;
    if (roomSelections[cruise.id] != null) return;
    roomSelections[cruise.id] = cruiseRooms(cruise).map((o) => o.room_label).filter(Boolean);
  }

  function includedRoomsFor(cruiseId) {
    if (roomSelections[cruiseId] != null) return roomSelections[cruiseId];
    const cruise = cruises.find((c) => c.id === cruiseId);
    return cruiseRooms(cruise).map((o) => o.room_label).filter(Boolean);
  }

  function buildCruiseOptions(ids) {
    const options = {};
    for (const id of ids) {
      options[id] = {
        included_room_labels: includedRoomsFor(id)
      };
      if (id === previewId && socialMediaId) {
        options[id].social_media_id = socialMediaId;
      }
    }
    return options;
  }

  function formatDate(value) {
    if (typeof global.formatAdminDate === "function") return global.formatAdminDate(value);
    return value || "";
  }

  function newsletterOptions() {
    const byNumber = new Map();
    const rows = Array.isArray(global.newsletters) ? global.newsletters : [];
    for (const row of rows) {
      const number = Number(row.newsletter_number);
      if (!Number.isFinite(number)) continue;
      byNumber.set(number, {
        number,
        id: row.id || null,
        date: row.newsletter_date || null
      });
    }
    const cruises = Array.isArray(global.featuredCruises) ? global.featuredCruises : [];
    for (const cruise of cruises) {
      if (cruise.newsletter_number == null || cruise.newsletter_number === "") continue;
      const number = Number(cruise.newsletter_number);
      if (!Number.isFinite(number) || byNumber.has(number)) continue;
      byNumber.set(number, {
        number,
        id: cruise.newsletter_id || null,
        date: cruise.newsletter_publication_date || null
      });
    }
    return [...byNumber.values()].sort((a, b) => b.number - a.number);
  }

  function cruisesForIssue(number, newsletterId = null) {
    const cruises = Array.isArray(global.featuredCruises) ? global.featuredCruises : [];
    const num = number != null && number !== "" ? Number(number) : null;
    const seen = new Set();
    const matched = [];
    for (const row of cruises) {
      const inIssue =
        (newsletterId && row.newsletter_id === newsletterId) ||
        (num != null && Number(row.newsletter_number) === num);
      if (!inIssue || seen.has(row.id)) continue;
      seen.add(row.id);
      matched.push(row);
    }
    if (!matched.length) return [];
    return matched.sort((a, b) => {
      const order = Number(a.display_order || 0) - Number(b.display_order || 0);
      if (order) return order;
      return String(a.headline || "").localeCompare(String(b.headline || ""), "en");
    });
  }

  async function ensureLoaded({ quiet = false } = {}) {
    if (typeof global.ensureFeaturedCruisesLoaded === "function") {
      await global.ensureFeaturedCruisesLoaded({ quiet });
    }
    if (global.NewsletterIssueComposer?.loadNewslettersFromDb) {
      await global.NewsletterIssueComposer.loadNewslettersFromDb();
    }
  }

  async function selectPanelIssue(value) {
    if (busy) return;
    if (!value) {
      close();
      return;
    }
    panelIssueNumber = Number(value);
    message = "";
    messageTone = "";
    const option = newsletterOptions().find((row) => row.number === panelIssueNumber);
    const list = cruisesForIssue(panelIssueNumber, option?.id || null);
    if (!list.length) {
      open = false;
      cruises = [];
      preview = null;
      previewId = null;
      message = "Add cruises to this newsletter before creating a Social Pack.";
      messageTone = "error";
      rerender();
      return;
    }
    const withHero = [];
    for (const cruise of list) {
      let hero = null;
      try {
        if (typeof global.resolveFeaturedCruiseImages === "function") {
          const resolved = await global.resolveFeaturedCruiseImages(cruise);
          hero = resolved?.hero || null;
        }
      } catch (_e) {
        /* ignore */
      }
      withHero.push({ ...cruise, hero });
    }
    await openForIssue(panelIssueNumber, withHero);
  }

  async function withAdminLoading(fn, { forZip = false } = {}) {
    if (global.AdminLoading?.withLoading) {
      return global.AdminLoading.withLoading(fn, {
        key: "social-pack",
        delayMs: 0,
        message: forZip ? "Preparing your social pack…" : "Creating your social graphics…",
        supportMessage: forZip
          ? "Please wait while we create the newsletter graphics and captions."
          : "Please wait while we prepare the destination campaign."
      });
    }
    return fn();
  }

  async function openForIssue(number, issueCruises) {
    issueNumber = Number(number);
    panelIssueNumber = issueNumber;
    open = true;
    busy = true;
    preview = null;
    previewId = null;
    socialMediaId = null;
    treatment = "soft";
    packTemplate = "classic";
    routeMapStyle = "classic";
    savingsDisplay = "percentage";
    savingsAvailable = false;
    packTemplateChosen = false;
    imagePickerOpen = false;
    roomSelections = {};
    candidateCache = {};
    lastDownloadUrl = null;
    packTemplateChosen = false;
    message = "Checking cruise readiness…";
    messageTone = "";
    cruises = (issueCruises || []).map((row) => ({
      id: row.id,
      headline: row.headline || "",
      destination: row.destination_strip || "",
      line: row.ci_cruise_lines?.name || "",
      ship: row.ci_cruise_ships?.name || "",
      departure: row.departure_date || "",
      returnDate: row.return_date || "",
      heroUrl: row.hero?.url || row.hero_image_url || "",
      selected: true,
      offers: [],
      readiness: { status: "pending", label: "Checking…" }
    }));
    rerender();

    const run = async () => {
    try {
      const headers = await authHeaders();
      const response = await fetch("/.netlify/functions/social-pack-generate", {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "readiness", newsletter_number: issueNumber })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) {
        throw new Error(data.error || "Could not load cruise readiness.");
      }
      const byId = new Map((data.cruises || []).map((c) => [c.id, c]));
      cruises = cruises.map((c) => {
        const remote = byId.get(c.id);
        if (!remote) return c;
        const next = {
          ...c,
          destination: remote.destination_strip || c.destination,
          line: remote.line_name || c.line,
          ship: remote.ship_name || c.ship,
          departure: remote.departure_date || c.departure,
          returnDate: remote.return_date || c.returnDate,
          heroUrl: remote.hero_url || c.heroUrl,
          readiness: remote.readiness || c.readiness,
          offers: remote.offers || [],
          selected: remote.readiness?.status !== "blocked"
        };
        ensureRoomDefaults(next);
        return next;
      });
      const firstReady = cruises.find((c) => c.selected && c.readiness?.status !== "blocked");
      message = firstReady ? "" : "No cruises are ready to generate yet.";
      messageTone = firstReady ? "" : "error";
      busy = false;
      rerender();
    } catch (error) {
      busy = false;
      message = error.message || "Could not open Social Pack.";
      messageTone = "error";
      rerender();
    }
    };

    if (typeof global.AdminLoading?.withLoading === "function") {
      await global.AdminLoading.withLoading(run, {
        key: "social-pack-open",
        delayMs: 0,
        message: "Opening Social Pack…",
        supportMessage: "Please wait while we check cruise readiness."
      });
    } else {
      await run();
    }
  }

  async function previewCruise(id) {
    if (!ensureTemplateChosen()) return;
    if (busy && previewId === id && preview) return;
    if (previewId !== id) {
      socialMediaId = null;
    }
    previewId = id;
    busy = true;
    message = "";
    messageTone = "";
    imagePickerOpen = false;
    const cruise = cruises.find((c) => c.id === id);
    if (cruise) ensureRoomDefaults(cruise);
    rerender();
    try {
      await withAdminLoading(async () => {
        const headers = await authHeaders();
        const response = await fetch("/.netlify/functions/social-pack-generate", {
          method: "POST",
          headers,
          body: JSON.stringify({
            action: "preview",
            featured_cruise_id: id,
            ...packRequestFields(),
            social_media_id: socialMediaId,
            included_room_labels: includedRoomsFor(id)
          })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success === false) {
          const ref = data.correlation_id ? ` Ref ${data.correlation_id.slice(0, 8)}.` : "";
          throw new Error(
            (data.error || "We couldn’t create the preview. Please try again.") + ref
          );
        }
        preview = data;
        if (cruise && Array.isArray(data.available_offers)) {
          cruise.offers = data.available_offers;
          ensureRoomDefaults(cruise);
        }
        // Keep the largest known pool for this cruise so Next/Previous can cycle
        // even if a later response temporarily returns a shorter list.
        const incoming = Array.isArray(data.background_candidates) ? data.background_candidates : [];
        if (incoming.length > (candidateCache[id]?.length || 0)) {
          candidateCache[id] = incoming;
        } else if (!candidateCache[id] && incoming.length) {
          candidateCache[id] = incoming;
        }
        if (data.background?.media_id) {
          socialMediaId = data.background.media_id;
        }
        savingsAvailable = Boolean(data.savings_available);
        const warnings = data.warnings || [];
        const promo = templateShowsSavings(packTemplate);
        if (!promo && (warnings.includes("no_public_price") || !(data.offers || []).length)) {
          message = "No public room prices are available for this cruise.";
          messageTone = "error";
        } else {
          message = promo
            ? "Preview ready. Downloads include full square (1080×1080) and portrait (1080×1350)."
            : "Preview ready. Downloads use full 1080×1350 resolution.";
          messageTone = "success";
        }
      });
    } catch (error) {
      preview = null;
      message = error.message || "We couldn’t create the preview. Please try again.";
      messageTone = "error";
    } finally {
      busy = false;
      rerender();
    }
  }

  async function regeneratePreview() {
    if (!previewId || busy) return;
    await previewCruise(previewId);
  }

  async function setPackTemplate(value) {
    hideTemplateVision();
    const next = String(value || "classic").toLowerCase();
    packTemplate = PACK_TEMPLATES.some(([key]) => key === next) ? next : "classic";
    packTemplateChosen = true;
    if (!templateShowsSavings(packTemplate)) savingsAvailable = false;
    message = "";
    messageTone = "";
    if (previewId) await regeneratePreview();
    else rerender();
  }

  async function setRouteMapStyle(value) {
    routeMapStyle = value === "social" ? "social" : "classic";
    message = "";
    messageTone = "";
    if (previewId) await regeneratePreview();
    else rerender();
  }

  async function setSavingsDisplay(value) {
    savingsDisplay = value === "dollar" ? "dollar" : "percentage";
    message = "";
    messageTone = "";
    if (previewId) await regeneratePreview();
    else rerender();
  }

  async function setTreatment(value) {
    treatment = String(value || "soft").toLowerCase();
    if (!["clear", "soft", "strong"].includes(treatment)) treatment = "soft";
    if (previewId) await regeneratePreview();
    else rerender();
  }

  function openImagePicker() {
    imagePickerOpen = true;
    imagePickerTab = "recommended";
    rerender();
  }

  function closeImagePicker() {
    imagePickerOpen = false;
    rerender();
  }

  function setImagePickerTab(tab) {
    imagePickerTab = tab;
    rerender();
  }

  async function useSocialImage(mediaId) {
    socialMediaId = mediaId || null;
    imagePickerOpen = false;
    if (previewId) await regeneratePreview();
    else rerender();
  }

  async function stepBackground(delta) {
    const list = candidateCache[previewId] || preview?.background_candidates || [];
    if (!list.length || busy) return;
    const currentId = socialMediaId || preview?.background?.media_id;
    let idx = list.findIndex((m) => m.id === currentId);
    if (idx < 0) idx = 0;
    const next = list[(idx + delta + list.length) % list.length];
    if (next?.id && next.id !== currentId) {
      await useSocialImage(next.id);
    } else if (next?.id && list.length === 1) {
      message = "Only one destination image is available for this cruise.";
      messageTone = "";
      rerender();
    }
  }

  function toggleRoom(cruiseId, roomLabel) {
    const cruise = cruises.find((c) => c.id === cruiseId);
    if (!cruise || busy) return;
    ensureRoomDefaults(cruise);
    const current = new Set(roomSelections[cruiseId] || []);
    if (current.has(roomLabel)) current.delete(roomLabel);
    else current.add(roomLabel);
    roomSelections[cruiseId] = Array.from(current);
    // Preserve display_order from available offers
    const order = cruiseRooms(cruise).map((o) => o.room_label);
    roomSelections[cruiseId] = order.filter((label) => current.has(label));
    rerender();
  }

  async function applyRoomSelectionAndPreview(cruiseId, roomLabel) {
    toggleRoom(cruiseId, roomLabel);
    if (previewId === cruiseId) await regeneratePreview();
  }

  function loadJsZip() {
    if (global.JSZip) return Promise.resolve(global.JSZip);
    return new Promise((resolve, reject) => {
      const existing = document.querySelector("script[data-social-pack-jszip]");
      if (existing) {
        existing.addEventListener("load", () => resolve(global.JSZip));
        existing.addEventListener("error", () => reject(new Error("Could not load ZIP helper.")));
        return;
      }
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
      script.async = true;
      script.dataset.socialPackJszip = "1";
      script.onload = () => {
        if (!global.JSZip) reject(new Error("Could not load ZIP helper."));
        else resolve(global.JSZip);
      };
      script.onerror = () => reject(new Error("Could not load ZIP helper."));
      document.head.appendChild(script);
    });
  }

  function triggerBrowserDownload(url, filename) {
    const a = document.createElement("a");
    a.href = url;
    a.rel = "noopener";
    if (filename) a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function saveDownloadFromResponse(response, fallbackName) {
    const type = String(response.headers.get("content-type") || "").toLowerCase();
    if (type.includes("application/json")) {
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) {
        throw new Error(data.error || "We couldn’t prepare the download. Please try again.");
      }
      if (!data.download_url) {
        throw new Error("We couldn’t prepare the download. Please try again.");
      }
      triggerBrowserDownload(data.download_url, data.filename || fallbackName);
      return data;
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "We couldn’t prepare the download. Please try again.");
    }
    const blob = await response.blob();
    if (!blob || blob.size < 100) {
      throw new Error("We couldn’t prepare the download. Please try again.");
    }
    const url = URL.createObjectURL(blob);
    triggerBrowserDownload(url, fallbackName);
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return { filename: fallbackName };
  }

  async function requestCruiseDownload(cruiseId, index) {
    const headers = await authHeaders();
    const response = await fetch("/.netlify/functions/social-pack-generate", {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "download_cruise",
        newsletter_number: issueNumber,
        featured_cruise_id: cruiseId,
        index,
        ...packRequestFields(),
        social_media_id: cruiseId === previewId ? socialMediaId : null,
        included_room_labels: includedRoomsFor(cruiseId),
        cruise_options: buildCruiseOptions([cruiseId])
      })
    });
    const type = String(response.headers.get("content-type") || "").toLowerCase();
    const data = type.includes("application/json")
      ? await response.json().catch(() => ({}))
      : {};
    if (!response.ok || data.success === false || !data.download_url) {
      throw new Error(data.error || "We couldn’t prepare the download. Please try again.");
    }
    return data;
  }

  async function downloadZip() {
    if (!ensureTemplateChosen()) return;
    const ids = selectedIds();
    if (!ids.length || busy) return;
    busy = true;
    message = "Preparing your social pack…";
    messageTone = "";
    lastDownloadUrl = null;
    rerender();
    try {
      await withAdminLoading(
        async () => {
          // One cruise — use the proven single-cruise path
          if (ids.length === 1) {
            const headers = await authHeaders();
            const response = await fetch("/.netlify/functions/social-pack-generate", {
              method: "POST",
              headers,
              body: JSON.stringify({
                action: "download_cruise",
                newsletter_number: issueNumber,
                featured_cruise_id: ids[0],
                index: 1,
                ...packRequestFields(),
                social_media_id: ids[0] === previewId ? socialMediaId : null,
                included_room_labels: includedRoomsFor(ids[0])
              })
            });
            const data = await saveDownloadFromResponse(
              response,
              `newsletter-${issueNumber}-social-pack.zip`
            );
            lastDownloadUrl = data.download_url || null;
            message = "Social Pack ZIP downloaded.";
            messageTone = "success";
            return;
          }

          // Multi-cruise: build each cruise ZIP separately (avoids Netlify 60s limit),
          // then merge into one newsletter ZIP in the browser.
          const parts = [];
          for (let i = 0; i < ids.length; i += 1) {
            if (global.AdminLoading?.setMessage) {
              global.AdminLoading.setMessage(`Preparing cruise ${i + 1} of ${ids.length}…`);
            }
            if (global.AdminLoading?.setSupportMessage) {
              global.AdminLoading.setSupportMessage(
                "Please wait while we create the newsletter graphics and captions."
              );
            }
            parts.push(await requestCruiseDownload(ids[i], i + 1));
          }

          if (global.AdminLoading?.setMessage) {
            global.AdminLoading.setMessage("Building newsletter ZIP…");
          }
          const JSZip = await loadJsZip();
          const master = new JSZip();
          for (const part of parts) {
            const zipRes = await fetch(part.download_url);
            if (!zipRes.ok) {
              throw new Error("We couldn’t prepare the download. Please try again.");
            }
            const buf = await zipRes.arrayBuffer();
            const cruiseZip = await JSZip.loadAsync(buf);
            const entries = [];
            cruiseZip.forEach((path, file) => {
              entries.push({ path, file });
            });
            for (const entry of entries) {
              if (entry.file.dir) continue;
              // Skip per-cruise root manifests — rebuild one combined manifest below
              if (/\/manifest\.json$/i.test(entry.path)) continue;
              master.file(entry.path, await entry.file.async("uint8array"));
            }
          }

          const root = `newsletter-${issueNumber}-social-pack`;
          const manifest = {
            newsletter_number: Number(issueNumber),
            generated_at: new Date().toISOString(),
            cruises: parts.map((part, i) => ({
              featured_cruise_id: ids[i],
              filename: part.filename || null,
              bytes: part.bytes || null
            }))
          };
          master.file(`${root}/manifest.json`, JSON.stringify(manifest, null, 2));

          const blob = await master.generateAsync({ type: "blob", compression: "DEFLATE" });
          const filename = `newsletter-${issueNumber}-social-pack.zip`;
          const url = URL.createObjectURL(blob);
          lastDownloadUrl = url;
          triggerBrowserDownload(url, filename);
          message = "Social Pack ZIP downloaded.";
          messageTone = "success";
        },
        { forZip: true }
      );
    } catch (error) {
      message = error.message || "We couldn’t prepare the download. Please try again.";
      messageTone = "error";
    } finally {
      busy = false;
      rerender();
    }
  }

  async function downloadThisCruise() {
    if (!ensureTemplateChosen()) return;
    if (!previewId || busy) return;
    busy = true;
    message = "Preparing your social pack…";
    messageTone = "";
    lastDownloadUrl = null;
    rerender();
    try {
      await withAdminLoading(
        async () => {
          const headers = await authHeaders();
          const response = await fetch("/.netlify/functions/social-pack-generate", {
            method: "POST",
            headers,
            body: JSON.stringify({
              action: "download_cruise",
              newsletter_number: issueNumber,
              featured_cruise_id: previewId,
              index: Math.max(
                1,
                cruises.findIndex((c) => c.id === previewId) + 1
              ),
              ...packRequestFields(),
              social_media_id: socialMediaId,
              included_room_labels: includedRoomsFor(previewId)
            })
          });
          const data = await saveDownloadFromResponse(
            response,
            `newsletter-${issueNumber}-cruise-social-pack.zip`
          );
          lastDownloadUrl = data.download_url || null;
          message = "Cruise Social Pack downloaded.";
          messageTone = "success";
        },
        { forZip: true }
      );
    } catch (error) {
      message = error.message || "We couldn’t prepare the download. Please try again.";
      messageTone = "error";
    } finally {
      busy = false;
      rerender();
    }
  }

  function toggleCruise(id) {
    const row = cruises.find((c) => c.id === id);
    if (!row || row.readiness?.status === "blocked") return;
    row.selected = !row.selected;
    rerender();
  }

  function close() {
    open = false;
    issueNumber = null;
    panelIssueNumber = null;
    preview = null;
    previewId = null;
    cruises = [];
    socialMediaId = null;
    imagePickerOpen = false;
    roomSelections = {};
    candidateCache = {};
    lastDownloadUrl = null;
    packTemplateChosen = false;
    message = "";
    if (typeof global.renderAdmin === "function") global.renderAdmin();
  }

  function rerender() {
    if (typeof global.renderAdmin === "function") global.renderAdmin();
  }

  function stepPreview(delta) {
    if (!ensureTemplateChosen()) return;
    const ready = selectedReady();
    if (!ready.length) return;
    socialMediaId = null;
    const idx = Math.max(0, ready.findIndex((c) => c.id === previewId));
    const next = ready[(idx + delta + ready.length) % ready.length];
    previewCruise(next.id);
  }

  function copyCaption() {
    const text = preview?.caption || "";
    if (!text) return;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => {
          message = "Caption copied.";
          messageTone = "success";
          rerender();
        },
        () => {
          message = "Could not copy caption.";
          messageTone = "error";
          rerender();
        }
      );
    }
  }

  function renderRoomChecks(cruise) {
    const rooms = cruiseRooms(cruise);
    if (!rooms.length) {
      return `<p class="admin-small admin-error">No public room prices are available for this cruise.</p>`;
    }
    const selected = new Set(includedRoomsFor(cruise.id));
    return `
      <div class="social-pack-rooms" role="group" aria-label="Room prices">
        <p class="admin-small"><strong>Room prices</strong></p>
        ${rooms
          .map((room) => {
            const label = room.room_label;
            const display = room.room_label_display || label;
            const price = room.price_label || "";
            const checked = selected.has(label) ? "checked" : "";
            return `
              <label class="social-pack-room">
                <input type="checkbox" ${checked} ${busy ? "disabled" : ""}
                  onchange="SocialPackAdmin.toggleRoom('${esc(cruise.id)}', '${esc(label)}')">
                <span>${esc(display)}${price ? ` · ${esc(price)}` : ""}</span>
              </label>`;
          })
          .join("")}
      </div>`;
  }

  function renderImagePicker() {
    if (!imagePickerOpen || !preview) return "";
    const sections = preview.picker_sections || {};
    const tabMap = {
      recommended: "Recommended",
      current_destination: "Current Destination",
      arrival: "Arrival",
      departure: "Departure",
      regional: "Regional",
      all: "All Destinations"
    };
    const rows = sections[imagePickerTab] || [];
    return `
      <div class="social-pack-image-picker">
        <div class="admin-list-top">
          <h4>Change Social Image</h4>
          <button type="button" class="admin-button secondary small" onclick="SocialPackAdmin.closeImagePicker()">Close</button>
        </div>
        <div class="media-picker-filters">
          ${Object.keys(tabMap)
            .map(
              (key) =>
                `<button type="button" class="media-filter-chip ${
                  imagePickerTab === key ? "is-active" : ""
                }" onclick="SocialPackAdmin.setImagePickerTab('${key}')">${tabMap[key]}</button>`
            )
            .join("")}
        </div>
        <div class="social-pack-image-grid">
          ${
            rows.length
              ? rows
                  .map(
                    (row) => `
            <article class="media-picker-card">
              <div class="media-picker-card-media"><img src="${esc(row.public_url)}" alt=""></div>
              <div class="media-picker-card-body">
                <h4 class="media-picker-card-title">${esc(row.title || "Untitled")}</h4>
                <p class="media-picker-card-meta">${esc(row.destination_name || "")}${
                      row.is_default ? " · Default" : ""
                    }</p>
                <button type="button" class="admin-button black small" onclick="SocialPackAdmin.useSocialImage('${esc(
                  row.id
                )}')" ${busy ? "disabled" : ""}>Use This Image</button>
              </div>
            </article>`
                  )
                  .join("")
              : `<p class="admin-muted">No images in this group.</p>`
          }
        </div>
      </div>`;
  }

  function renderChoiceGroup(label, options, current, handler, visible = true) {
    if (!visible) return "";
    const demoAttr = handler === "setPackTemplate";
    return `
      <div class="social-pack-treatment" role="group" aria-label="${esc(label)}">
        <span class="admin-small">${esc(label)}</span>
        ${options
          .map(([value, text]) => {
            const demo = demoAttr && TEMPLATE_DEMOS[value] ? ` data-social-pack-demo="${esc(value)}"` : "";
            return `<button type="button" class="media-filter-chip${demoAttr ? " social-pack-type-chip" : ""} ${
              current === value ? "is-active" : ""
            }" onclick="SocialPackAdmin.${handler}('${value}')"${demo} ${busy ? "disabled" : ""}>${esc(text)}</button>`;
          })
          .join("")}
      </div>`;
  }

  function renderTemplateSelector() {
    const prompt = packTemplateChosen
      ? ""
      : `<p class="admin-small admin-error">Choose a template before previewing or downloading.</p>`;
    return `
      ${prompt}
      <div class="social-pack-choice-stack">
        ${renderChoiceGroup(
          "Social Pack Template",
          PACK_TEMPLATES,
          packTemplateChosen ? packTemplate : "",
          "setPackTemplate"
        )}
        ${renderChoiceGroup(
          "Route Map Style",
          [
            ["classic", "Classic"],
            ["social", "Social"]
          ],
          routeMapStyle,
          "setRouteMapStyle",
          packTemplateChosen && templateHasMap(packTemplate)
        )}
        ${renderChoiceGroup(
          "Savings Display",
          [
            ["percentage", "Percentage"],
            ["dollar", "Dollar Saving"]
          ],
          savingsDisplay,
          "setSavingsDisplay",
          packTemplateChosen && templateShowsSavings(packTemplate) && savingsAvailable
        )}
      </div>`;
  }

  function slidePreviewClass(name) {
    const key = String(name || "").toLowerCase();
    return /(^|[-_/])square([-_.]|$)/.test(key) ? "is-square" : "is-portrait";
  }

  function renderSlides() {
    if (!preview?.slides) return "";
    const order = preview.slide_order || Object.keys(preview.slides);
    return `
      <div class="social-pack-slides">
        ${order
          .map((name, i) => {
            const src = preview.slides[name];
            if (!src) return "";
            return `<figure class="${slidePreviewClass(name)}"><img src="${esc(src)}" alt="${esc(name)}"><figcaption>${i + 1}. ${esc(
              name
            )}</figcaption></figure>`;
          })
          .join("")}
      </div>`;
  }

  function renderWorkspace() {
    const selectedCount = cruises.filter((c) => c.selected).length;
    const msgClass =
      messageTone === "error" ? "admin-error" : messageTone === "success" ? "admin-success" : "";
    const bg = preview?.background;
    const activeCruise = cruises.find((c) => c.id === previewId);
    return `
      <div class="social-pack-workspace">
        <div class="admin-list-top">
          <div>
            <p class="admin-muted">Newsletter ${esc(issueNumber)} · ${esc(selectedCount)} selected</p>
          </div>
        </div>
        ${message ? `<div class="admin-message ${msgClass}">${esc(message)}</div>` : ""}
        ${renderTemplateSelector()}
        <div class="social-pack-layout">
          <div class="social-pack-list">
            ${cruises
              .map(
                (c) => `
              <div class="social-pack-cruise ${c.id === previewId ? "is-active" : ""} ${c.readiness?.status === "blocked" ? "is-blocked" : ""}">
                <label class="social-pack-cruise-main">
                  <input type="checkbox" ${c.selected ? "checked" : ""} ${
                    c.readiness?.status === "blocked" || busy ? "disabled" : ""
                  } onchange="SocialPackAdmin.toggleCruise('${esc(c.id)}')">
                  <span class="social-pack-thumb">${
                    c.heroUrl
                      ? `<img src="${esc(c.heroUrl)}" alt="" loading="lazy">`
                      : `<span class="admin-empty-preview">No image</span>`
                  }</span>
                  <span class="social-pack-cruise-copy">
                    <strong>${esc(c.destination || c.headline || "Cruise")}</strong>
                    <span class="admin-small">${esc([c.line, c.ship].filter(Boolean).join(" · "))}</span>
                    <span class="admin-small">${esc([c.departure, c.returnDate].filter(Boolean).join(" → "))}</span>
                    <span class="admin-small">${esc(c.readiness?.label || "")}</span>
                  </span>
                </label>
                <button type="button" class="admin-button secondary small" onclick="SocialPackAdmin.previewCruise('${esc(c.id)}')" ${
                  busy || c.readiness?.status === "blocked" ? "disabled" : ""
                }>Preview</button>
                ${c.id === previewId ? renderRoomChecks(c) : ""}
              </div>`
              )
              .join("")}
          </div>
          <div class="social-pack-preview">
            ${
              preview?.slides
                ? `
                  <div class="social-pack-controls">
                    <button type="button" class="admin-button secondary small" onclick="SocialPackAdmin.openImagePicker()" ${busy ? "disabled" : ""}>Change Social Image</button>
                    <div class="social-pack-treatment" role="group" aria-label="Background treatment">
                      <span class="admin-small">Background</span>
                      ${["clear", "soft", "strong"]
                        .map(
                          (t) =>
                            `<button type="button" class="media-filter-chip ${
                              treatment === t ? "is-active" : ""
                            }" onclick="SocialPackAdmin.setTreatment('${t}')" ${busy ? "disabled" : ""}>${
                              t.charAt(0).toUpperCase() + t.slice(1)
                            }</button>`
                        )
                        .join("")}
                    </div>
                    <button type="button" class="admin-button secondary small" onclick="SocialPackAdmin.stepBackground(-1)" ${busy ? "disabled" : ""}>Previous Image</button>
                    <button type="button" class="admin-button secondary small" onclick="SocialPackAdmin.stepBackground(1)" ${busy ? "disabled" : ""}>Next Image</button>
                    <button type="button" class="admin-button secondary small" onclick="SocialPackAdmin.regeneratePreview()" ${busy ? "disabled" : ""}>Regenerate Preview</button>
                  </div>
                  ${
                    bg
                      ? `<p class="admin-small">Image: ${esc(bg.title || bg.media_id || "—")} · ${esc(
                          bg.destination_key || ""
                        )} · ${esc(bg.match_role || "")} · rotation ${esc(
                          String(bg.rotation_index ?? "")
                        )}/${esc(String(bg.candidate_count ?? ""))}</p>`
                      : ""
                  }
                  <p class="admin-small">${
                    templateShowsSavings(packTemplate)
                      ? "Preview shows the complete square (1080×1080) and portrait (1080×1350) frames. Downloads use the full-resolution files."
                      : "Preview is reduced resolution for Admin. Downloads remain full 1080×1350."
                  }</p>
                  ${
                    activeCruise &&
                    !templateShowsSavings(packTemplate) &&
                    !(activeCruise.offers || []).length
                      ? `<div class="admin-message admin-error">No public room prices are available for this cruise.</div>`
                      : ""
                  }
                  ${renderImagePicker()}
                  ${renderSlides()}
                  <label class="admin-field"><span>Caption</span>
                    <textarea class="social-pack-caption" readonly rows="10">${esc(preview.caption || "")}</textarea>
                  </label>
                  <div class="admin-actions-row">
                    <button type="button" class="admin-button secondary small" onclick="SocialPackAdmin.copyCaption()" ${busy ? "disabled" : ""}>Copy caption</button>
                    <button type="button" class="admin-button secondary" onclick="SocialPackAdmin.stepPreview(-1)" ${busy ? "disabled" : ""}>Previous cruise</button>
                    <button type="button" class="admin-button secondary" onclick="SocialPackAdmin.stepPreview(1)" ${busy ? "disabled" : ""}>Next cruise</button>
                  </div>`
                : `<p class="admin-muted">${busy ? "Creating your social graphics…" : "Click Preview on a cruise when ready."}</p>`
            }
          </div>
        </div>
        <div class="admin-actions-row" style="margin-top:16px">
          <button type="button" class="admin-button secondary" onclick="SocialPackAdmin.downloadThisCruise()" ${
            busy || !previewId ? "disabled" : ""
          }>Download This Cruise</button>
          <button type="button" class="admin-button black" onclick="SocialPackAdmin.downloadZip()" ${
            busy || !selectedIds().length ? "disabled" : ""
          }>${busy ? "Working…" : "Download Newsletter Social Pack"}</button>
        </div>
        ${
          lastDownloadUrl
            ? `<p class="admin-muted" style="margin-top:10px"><a href="${esc(lastDownloadUrl)}" target="_blank" rel="noopener">Open last download link</a> (expires soon)</p>`
            : ""
        }
      </div>
    `;
  }

  function renderTemplatePrompt() {
    return `
      <div class="social-pack-template-prompt" role="dialog" aria-modal="true" aria-label="Choose Social Pack template">
        <div class="social-pack-template-prompt-card admin-card">
          <p class="admin-nav-eyebrow">Social Pack</p>
          <h4>Choose a template</h4>
          <p class="admin-muted">Pick a Social Pack template before previewing or downloading. Classic and Premium Dark stay as they are.</p>
          <div class="social-pack-choice-stack" style="margin-top:16px">
            ${PACK_TEMPLATES.map(
              ([value, label]) =>
                `<button type="button" class="media-filter-chip social-pack-type-chip" data-social-pack-demo="${esc(
                  value
                )}" onclick="SocialPackAdmin.setPackTemplate('${value}')" ${
                  busy ? "disabled" : ""
                }>${esc(label)}</button>`
            ).join("")}
          </div>
        </div>
      </div>
    `;
  }

  function renderPanel() {
    const options = newsletterOptions();
    const selected = panelIssueNumber ?? issueNumber ?? "";
    const idleMsgClass =
      messageTone === "error" ? "admin-error" : messageTone === "success" ? "admin-success" : "";
    return `
      <div class="admin-card social-pack-panel">
        <div class="admin-list-top">
          <div>
            <p class="admin-nav-eyebrow">Marketing</p>
            <h3>Social Pack</h3>
            <p class="admin-muted">Create Instagram graphics and captions for cruises in a newsletter issue.</p>
          </div>
        </div>
        <label class="admin-field">
          <span>Newsletter issue</span>
          <select onchange="SocialPackAdmin.selectPanelIssue(this.value)" ${busy ? "disabled" : ""}>
            <option value="">Choose newsletter…</option>
            ${options
              .map(
                (row) =>
                  `<option value="${row.number}" ${
                    Number(selected) === row.number ? "selected" : ""
                  }>Newsletter ${esc(row.number)}${
                    row.date ? ` · ${esc(formatDate(row.date))}` : ""
                  }</option>`
              )
              .join("")}
          </select>
        </label>
        ${
          open
            ? renderWorkspace()
            : message
              ? `<div class="admin-message ${idleMsgClass}">${esc(message)}</div>`
              : `<p class="admin-muted">Choose a newsletter issue to load its cruises.</p>`
        }
      </div>
      ${open && !packTemplateChosen && !busy ? renderTemplatePrompt() : ""}
    `;
  }

  function renderModal() {
    return "";
  }

  function visionCard() {
    let el = document.getElementById("socialPackTypeVision");
    if (!el) {
      el = document.createElement("div");
      el.id = "socialPackTypeVision";
      el.className = "social-pack-type-vision";
      el.hidden = true;
      el.setAttribute("role", "tooltip");
      document.body.appendChild(el);
    }
    return el;
  }

  function hideTemplateVision() {
    const el = document.getElementById("socialPackTypeVision");
    if (!el) return;
    el.hidden = true;
    el.innerHTML = "";
  }

  function positionTemplateVision(el, anchor) {
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(300, window.innerWidth - 24);
    el.style.width = `${width}px`;
    const cardH = el.offsetHeight || 360;
    let left = rect.left;
    let top = rect.bottom + 10;
    if (left + width > window.innerWidth - 12) left = window.innerWidth - width - 12;
    if (left < 12) left = 12;
    if (top + cardH > window.innerHeight - 12) top = Math.max(12, rect.top - cardH - 10);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  function showTemplateVision(anchor) {
    const demo = TEMPLATE_DEMOS[anchor?.dataset?.socialPackDemo];
    if (!demo) return;
    const el = visionCard();
    el.innerHTML = `
      <div class="social-pack-type-vision-art">${demo.svg}</div>
      <strong>${esc(demo.title)}</strong>
      <span>${esc(demo.note)}</span>
      <em>Sample layout — not this cruise</em>`;
    el.hidden = false;
    positionTemplateVision(el, anchor);
  }

  function isVisionRelated(node) {
    return Boolean(node?.closest?.("[data-social-pack-demo], #socialPackTypeVision"));
  }

  if (!global.__socialPackTemplateVisionInstalled) {
    document.addEventListener("pointerover", (event) => {
      const button = event.target?.closest?.("[data-social-pack-demo]");
      if (button) showTemplateVision(button);
    });
    document.addEventListener("pointerout", (event) => {
      if (isVisionRelated(event.relatedTarget)) return;
      if (event.target?.closest?.("[data-social-pack-demo], #socialPackTypeVision")) hideTemplateVision();
    });
    document.addEventListener("focusin", (event) => {
      const button = event.target?.closest?.("[data-social-pack-demo]");
      if (button) showTemplateVision(button);
    });
    document.addEventListener("focusout", (event) => {
      if (isVisionRelated(event.relatedTarget)) return;
      hideTemplateVision();
    });
    document.addEventListener("scroll", hideTemplateVision, true);
    window.addEventListener("resize", hideTemplateVision);
    global.__socialPackTemplateVisionInstalled = true;
  }

  global.SocialPackAdmin = {
    openForIssue,
    close,
    ensureLoaded,
    selectPanelIssue,
    toggleCruise,
    toggleRoom: applyRoomSelectionAndPreview,
    previewCruise,
    downloadZip,
    downloadThisCruise,
    stepPreview,
    setTreatment,
    setPackTemplate,
    setRouteMapStyle,
    setSavingsDisplay,
    openImagePicker,
    closeImagePicker,
    setImagePickerTab,
    useSocialImage,
    stepBackground,
    regeneratePreview,
    copyCaption,
    renderPanel,
    renderModal,
    isOpen: () => open
  };
})(typeof window !== "undefined" ? window : globalThis);
