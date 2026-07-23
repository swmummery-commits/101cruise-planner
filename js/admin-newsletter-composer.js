/**
 * Sprint 13C — Newsletter Issue Composer.
 *
 * Assembles Featured Cruises for one newsletter number into a multi-cruise
 * Mailchimp fragment. Reuses NewsletterPreview + NewsletterMailchimpExport.
 *
 * TEMPORARY — design template persistence:
 * The selected Design Template is stored in browser localStorage keyed by
 * newsletter number. The current schema has no per-issue record
 * (featured_cruise_newsletter_defaults is a singleton for new-cruise defaults
 * only; featured_cruises has no template column). Do not invent a denormalised
 * template field on every cruise. Replace this with a newsletter_issues (or
 * equivalent) persistence field when that table is introduced.
 */
(function (global) {
  "use strict";

  /** @temporary Replace when newsletter issue rows support a template column. */
  const TEMPLATE_STORAGE_KEY = "101cruise.newsletterIssue.templateByNumber.temporary";

  let issueNumber = null;
  let issueDate = "";
  let issueTemplate = "green-price-cards";
  let issuePricingByCruiseId = {};
  let issuePricingLoadedFor = "";
  let issueBusy = false;
  let issueMessage = "";
  let issueMessageTone = "";
  let issueWarnings = [];
  let issueHtml = {
    airline: "",
    general: "",
    previewMode: "",
    previewHtml: "",
    filename: "",
    label: ""
  };
  let issueCache = { key: "", airline: null, general: null };
  let addPickerOpen = false;
  let addPickerSelected = new Set();
  let draggedCruiseId = null;
  let dragFromHandle = false;

  function esc(value) {
    if (typeof global.esc === "function") return global.esc(value);
    if (value === null || value === undefined) return "";
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function formatDate(value) {
    if (typeof global.formatAdminDate === "function") return global.formatAdminDate(value);
    return value || "—";
  }

  function getCruises() {
    return Array.isArray(global.featuredCruises) ? global.featuredCruises : [];
  }

  function getDefaults() {
    return (
      global.featuredNewsletterDefaults || {
        newsletter_number: null,
        newsletter_publication_date: null
      }
    );
  }

  function getCruiseLines() {
    return Array.isArray(global.ciCruiseLines) ? global.ciCruiseLines : [];
  }

  function getCruiseShips() {
    return Array.isArray(global.ciCruiseShips) ? global.ciCruiseShips : [];
  }

  function invalidateCache() {
    issueCache = { key: "", airline: null, general: null };
    issueHtml = {
      airline: "",
      general: "",
      previewMode: "",
      previewHtml: "",
      filename: "",
      label: ""
    };
  }

  function loadTemplateMap() {
    // TEMPORARY: browser-only until a newsletter_issues table (or similar) exists.
    try {
      const primary = JSON.parse(localStorage.getItem(TEMPLATE_STORAGE_KEY) || "{}") || {};
      // Migrate once from the pre-marked temporary key if present.
      const legacyKey = "101cruise.newsletterIssue.templateByNumber";
      if (!Object.keys(primary).length) {
        const legacy = JSON.parse(localStorage.getItem(legacyKey) || "{}") || {};
        if (Object.keys(legacy).length) {
          localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(legacy));
          return legacy;
        }
      }
      return primary;
    } catch {
      return {};
    }
  }

  function saveTemplateForNumber(number, template) {
    // TEMPORARY: browser-only until issue-level DB persistence exists.
    const map = loadTemplateMap();
    map[String(number)] = template;
    localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(map));
  }

  function templateForNumber(number) {
    const map = loadTemplateMap();
    const stored = map[String(number)];
    if (stored === "classic-editorial" || stored === "green-price-cards") return stored;
    return "green-price-cards";
  }

  function availableNewsletterNumbers() {
    const set = new Set();
    for (const row of getCruises()) {
      if (row.newsletter_number != null && row.newsletter_number !== "") {
        set.add(Number(row.newsletter_number));
      }
    }
    const defaults = getDefaults();
    if (defaults.newsletter_number != null && defaults.newsletter_number !== "") {
      set.add(Number(defaults.newsletter_number));
    }
    if (issueNumber != null) set.add(Number(issueNumber));
    return [...set].filter((n) => Number.isFinite(n)).sort((a, b) => b - a);
  }

  function cruisesForCurrentIssue() {
    if (issueNumber == null || issueNumber === "") return [];
    const num = Number(issueNumber);
    return getCruises()
      .filter((row) => Number(row.newsletter_number) === num)
      .sort((a, b) => {
        const order = Number(a.display_order || 0) - Number(b.display_order || 0);
        if (order) return order;
        return String(a.headline || "").localeCompare(String(b.headline || ""), "en");
      });
  }

  function unassignedCruises() {
    const num = Number(issueNumber);
    return getCruises()
      .filter((row) => {
        if ((row.publication_status || "draft") === "archived") return false;
        if (row.newsletter_number == null || row.newsletter_number === "") return true;
        if (issueNumber == null || issueNumber === "") return false;
        return Number(row.newsletter_number) !== num;
      })
      .sort((a, b) => String(a.headline || "").localeCompare(String(b.headline || ""), "en"));
  }

  function unnumberedCruises() {
    return getCruises()
      .filter((row) => {
        if ((row.publication_status || "draft") === "archived") return false;
        return row.newsletter_number == null || row.newsletter_number === "";
      })
      .sort((a, b) => String(a.headline || "").localeCompare(String(b.headline || ""), "en"));
  }

  function resolveIssueDate(number) {
    const cruises = getCruises().filter((row) => Number(row.newsletter_number) === Number(number));
    const dates = cruises.map((c) => c.newsletter_publication_date).filter(Boolean);
    if (dates.length) {
      const counts = {};
      for (const d of dates) counts[d] = (counts[d] || 0) + 1;
      return Object.entries(counts).sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0][0];
    }
    const defaults = getDefaults();
    if (Number(defaults.newsletter_number) === Number(number) && defaults.newsletter_publication_date) {
      return defaults.newsletter_publication_date;
    }
    return "";
  }

  function ensureIssueSelected() {
    const numbers = availableNewsletterNumbers();
    const defaults = getDefaults();
    if (issueNumber == null || issueNumber === "") {
      if (defaults.newsletter_number != null && defaults.newsletter_number !== "") {
        issueNumber = Number(defaults.newsletter_number);
      } else if (numbers.length) {
        issueNumber = numbers[0];
      } else {
        issueNumber = null;
      }
    }
    if (issueNumber != null) {
      issueDate = resolveIssueDate(issueNumber) || defaults.newsletter_publication_date || "";
      issueTemplate = templateForNumber(issueNumber);
    }
  }

  async function startIssue() {
    const numberInput = document.getElementById("newsletterStartNumber");
    const dateInput = document.getElementById("newsletterStartDate");
    const rawNumber = numberInput?.value ?? "";
    const nextNumber = Number(rawNumber);
    if (!Number.isFinite(nextNumber) || nextNumber < 1) {
      issueMessage = "Enter a newsletter number (for example 77) to start this issue.";
      issueMessageTone = "error";
      rerender();
      return;
    }
    const nextDate = String(dateInput?.value || "").trim() || getDefaults().newsletter_publication_date || "";
    issueNumber = nextNumber;
    issueDate = nextDate;
    issueTemplate = templateForNumber(issueNumber);
    saveTemplateForNumber(issueNumber, issueTemplate);
    invalidateCache();
    issuePricingLoadedFor = "";

    // Persist as newsletter defaults so New Cruise inherits this issue.
    try {
      if (global.supabaseClient) {
        await global.supabaseClient.from("featured_cruise_newsletter_defaults").upsert({
          id: 1,
          newsletter_number: nextNumber,
          newsletter_publication_date: nextDate || null
        });
        global.featuredNewsletterDefaults = {
          newsletter_number: nextNumber,
          newsletter_publication_date: nextDate || null
        };
      }
    } catch {
      /* defaults upsert is best-effort */
    }

    issueMessage = `Newsletter ${nextNumber} ready. Add your existing cruises below.`;
    issueMessageTone = "success";
    try {
      const cruises = cruisesForCurrentIssue();
      await ensurePricingLoaded(cruises);
      issueWarnings = collectWarnings(cruises);
    } catch {
      issueWarnings = [];
    }
    rerender();
  }

  function heroThumbUrl(cruise) {
    if (typeof global.resolveFeaturedCruiseImages === "function") {
      const resolved = global.resolveFeaturedCruiseImages(cruise);
      if (resolved?.hero?.url) return resolved.hero.url;
    }
    return (
      cruise.hero_image_url ||
      cruise.ci_cruise_ships?.hero_image_url ||
      ""
    );
  }

  function collectWarnings(cruises) {
    const warnings = [];
    for (const cruise of cruises) {
      const name = cruise.headline || "Untitled cruise";
      const pricing = issuePricingByCruiseId[cruise.id] || [];
      const hasPrice = pricing.some(
        (p) =>
          p.brochure_price != null ||
          p.cruise_101_price != null ||
          p.airline_price != null
      );
      const hero = heroThumbUrl(cruise);
      if (!hero) warnings.push(`${name}: missing hero image`);
      if (!hasPrice) warnings.push(`${name}: missing pricing`);
      if (!String(cruise.public_slug || "").trim()) warnings.push(`${name}: missing public slug`);
      if ((cruise.publication_status || "draft") !== "published") {
        warnings.push(
          `${name}: Public page unavailable — set Publication Status to Published before export (Explore More must open a live page).`
        );
      }
    }
    return warnings;
  }

  function issueStatus(cruises, warnings) {
    if (!cruises.length) return { key: "draft", label: "Draft" };
    if (warnings.length) return { key: "draft", label: "Draft" };
    if (!issueTemplate) return { key: "draft", label: "Draft" };
    return { key: "ready", label: "Ready" };
  }

  async function ensurePricingLoaded(cruises) {
    const ids = cruises.map((c) => c.id).filter(Boolean);
    const key = `${issueNumber}:${ids.join(",")}`;
    if (key === issuePricingLoadedFor && Object.keys(issuePricingByCruiseId).length) return;
    if (!ids.length) {
      issuePricingByCruiseId = {};
      issuePricingLoadedFor = key;
      return;
    }
    const client = global.supabaseClient;
    if (!client) throw new Error("Database client is not ready.");
    const { data, error } = await client
      .from("featured_cruise_pricing")
      .select("*")
      .in("featured_cruise_id", ids)
      .order("display_order", { ascending: true });
    if (error) throw new Error(error.message);
    const map = {};
    for (const id of ids) map[id] = [];
    for (const row of data || []) {
      if (!map[row.featured_cruise_id]) map[row.featured_cruise_id] = [];
      map[row.featured_cruise_id].push(row);
    }
    issuePricingByCruiseId = map;
    issuePricingLoadedFor = key;
  }

  function formatMoneyCell(value) {
    if (value === "" || value == null) return "—";
    const num = Number(value);
    if (!Number.isFinite(num)) return "—";
    const shared = global.NewsletterCruiseShared;
    if (shared?.formatMoney) return `$${shared.formatMoney(num)}`;
    return `$${Math.round(num).toLocaleString("en-AU")}`;
  }

  function cruiseDateRange(cruise) {
    const departure = cruise.departure_date || "";
    const nightsNum = cruise.nights == null || cruise.nights === "" ? null : Number(cruise.nights);
    const returnDate =
      (typeof global.addCalendarDays === "function"
        ? global.addCalendarDays(departure, nightsNum)
        : "") ||
      cruise.return_date ||
      "";
    if (global.NewsletterPreview?.formatNewsletterDateRange) {
      const range = global.NewsletterPreview.formatNewsletterDateRange(departure, returnDate);
      if (range) return range;
    }
    if (departure && returnDate) return `${formatDate(departure)} – ${formatDate(returnDate)}`;
    return formatDate(departure || returnDate || "");
  }

  function destinationForCruise(cruise) {
    if (typeof global.buildFeaturedDestinationStrip === "function") {
      const strip = global.buildFeaturedDestinationStrip(cruise.departure_port, cruise.arrival_port);
      if (strip) return strip;
    }
    return String(cruise.destination_strip || "").trim().toUpperCase() || "—";
  }

  function lineNameForCruise(cruise) {
    return (
      cruise.ci_cruise_lines?.name ||
      getCruiseLines().find((row) => row.id === cruise.cruise_line_id)?.name ||
      "—"
    );
  }

  function shipNameForCruise(cruise) {
    return (
      cruise.ci_cruise_ships?.name ||
      getCruiseShips().find((row) => row.id === cruise.cruise_ship_id)?.name ||
      "—"
    );
  }

  function buildPrintRecordHtml(cruises) {
    const shared = global.NewsletterCruiseShared;
    const cruiseBlocks = cruises
      .map((cruise, index) => {
        const pricing = shared?.sortPricingRows
          ? shared.sortPricingRows(issuePricingByCruiseId[cruise.id] || [])
          : [...(issuePricingByCruiseId[cruise.id] || [])];
        const nightsLabel =
          cruise.nights != null && cruise.nights !== ""
            ? `${Number(cruise.nights)} night${Number(cruise.nights) === 1 ? "" : "s"}`
            : "";
        const rowsHtml = pricing.length
          ? pricing
              .map((row) => {
                const cabin = String(row.room_label || "").trim() || "—";
                return `<tr>
                  <td>${esc(cabin)}</td>
                  <td class="num">${esc(formatMoneyCell(row.brochure_price))}</td>
                  <td class="num">${esc(formatMoneyCell(row.cruise_101_price))}</td>
                  <td class="num">${esc(formatMoneyCell(row.airline_price))}</td>
                </tr>`;
              })
              .join("")
          : `<tr><td colspan="4">No cabin pricing entered</td></tr>`;

        return `
          <section class="cruise">
            <h2>${esc(String(index + 1))}. ${esc(destinationForCruise(cruise))}</h2>
            <dl>
              <div><dt>Cruise dates</dt><dd>${esc(cruiseDateRange(cruise))}${
                nightsLabel ? ` (${esc(nightsLabel)})` : ""
              }</dd></div>
              <div><dt>Cruise line</dt><dd>${esc(lineNameForCruise(cruise))}</dd></div>
              <div><dt>Ship</dt><dd>${esc(shipNameForCruise(cruise))}</dd></div>
            </dl>
            <table>
              <thead>
                <tr>
                  <th>Cabin</th>
                  <th class="num">Brochure</th>
                  <th class="num">101cruise</th>
                  <th class="num">Airline</th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </section>
        `;
      })
      .join("");

    return `<!doctype html>
<html lang="en-AU">
<head>
  <meta charset="utf-8">
  <title>Newsletter ${esc(String(issueNumber))} — cruise record</title>
  <style>
    @page { margin: 16mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      color: #000;
      background: #fff;
      font-family: Helvetica, Arial, sans-serif;
      font-size: 12px;
      line-height: 1.4;
    }
    h1 {
      margin: 0 0 4px;
      font-size: 20px;
      font-weight: 700;
    }
    .eyebrow {
      margin: 0 0 2px;
      font-size: 11px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .meta {
      margin: 0 0 18px;
      font-size: 12px;
    }
    .cruise {
      margin: 0 0 18px;
      padding: 0 0 14px;
      border-bottom: 1px solid #000;
      page-break-inside: avoid;
    }
    .cruise:last-child { border-bottom: none; }
    h2 {
      margin: 0 0 8px;
      font-size: 14px;
      font-weight: 700;
      text-transform: uppercase;
    }
    dl {
      margin: 0 0 10px;
      display: grid;
      gap: 4px;
    }
    dl div { display: grid; grid-template-columns: 100px 1fr; gap: 8px; }
    dt { margin: 0; font-weight: 700; }
    dd { margin: 0; }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      border: 1px solid #000;
      padding: 6px 8px;
      text-align: left;
      vertical-align: top;
    }
    th { font-weight: 700; }
    .num { text-align: right; white-space: nowrap; }
    .footer {
      margin-top: 16px;
      font-size: 11px;
    }
  </style>
</head>
<body>
  <p class="eyebrow">101cruise · Weekly cruise record</p>
  <h1>Newsletter ${esc(String(issueNumber))}</h1>
  <p class="meta">Published ${esc(issueDate ? formatDate(issueDate) : "—")} · ${esc(String(cruises.length))} cruise${cruises.length === 1 ? "" : "s"}</p>
  ${cruiseBlocks}
  <p class="footer">Prices per person in USD as entered for this issue. Internal record only.</p>
</body>
</html>`;
  }

  async function printRecord() {
    if (issueNumber == null) {
      issueMessage = "Select a newsletter number before printing.";
      issueMessageTone = "error";
      rerender();
      return;
    }
    const cruises = cruisesForCurrentIssue();
    if (!cruises.length) {
      issueMessage = "Add at least one cruise to this issue before printing.";
      issueMessageTone = "error";
      rerender();
      return;
    }
    try {
      issueBusy = true;
      issueMessage = "Preparing print record…";
      issueMessageTone = "running";
      rerender();
      await ensurePricingLoaded(cruises);
      const html = buildPrintRecordHtml(cruises);
      const printWindow = window.open("", "_blank", "noopener,noreferrer");
      if (!printWindow) {
        throw new Error("Pop-up blocked. Allow pop-ups for Admin to print this record.");
      }
      printWindow.document.open();
      printWindow.document.write(html);
      printWindow.document.close();
      printWindow.focus();
      window.setTimeout(() => {
        try {
          printWindow.print();
        } catch (_error) {
          /* user can print manually from the opened tab */
        }
      }, 250);
      issueMessage = "Print dialog opened for this newsletter’s cruise record.";
      issueMessageTone = "success";
    } catch (error) {
      issueMessage = error.message || "Could not prepare the print record.";
      issueMessageTone = "error";
    } finally {
      issueBusy = false;
      rerender();
    }
  }

  function buildModelForCruise(cruise, outputMode) {
    const departure = cruise.departure_date || "";
    const nightsNum = cruise.nights == null || cruise.nights === "" ? null : Number(cruise.nights);
    const returnDate =
      (typeof global.addCalendarDays === "function"
        ? global.addCalendarDays(departure, nightsNum)
        : "") ||
      cruise.return_date ||
      "";
    const destinationStrip =
      (typeof global.buildFeaturedDestinationStrip === "function"
        ? global.buildFeaturedDestinationStrip(cruise.departure_port, cruise.arrival_port)
        : "") ||
      cruise.destination_strip ||
      "";
    const line =
      cruise.ci_cruise_lines ||
      (global.ciCruiseLines || []).find((row) => row.id === cruise.cruise_line_id);
    const ship =
      cruise.ci_cruise_ships ||
      (global.ciCruiseShips || []).find((row) => row.id === cruise.cruise_ship_id);
    const resolved =
      typeof global.resolveFeaturedCruiseImages === "function"
        ? global.resolveFeaturedCruiseImages(cruise)
        : { hero: null, routeMap: null };
    const pricingRows = issuePricingByCruiseId[cruise.id] || [];

    return global.NewsletterPreview.buildModel({
      destinationStrip,
      headline: cruise.headline || "",
      hero: resolved.hero,
      heroImageUrl: resolved.hero?.url || cruise.hero_image_url || "",
      heroImageAlt:
        resolved.hero?.altText || cruise.hero_image_alt || cruise.headline || "Cruise image",
      departureDate: departure,
      returnDate,
      nights: nightsNum,
      cruiseLineName: line?.name || "",
      shipName: ship?.name || "",
      itinerarySummary: cruise.itinerary_summary || "",
      short_editorial: cruise.short_editorial || "",
      full_description: cruise.full_description || "",
      description: cruise.short_editorial || "",
      publicSlug: cruise.public_slug || "",
      routeMap: resolved.routeMap,
      routeMapUrl: resolved.routeMap?.url || cruise.route_map_image_url || "",
      pricingRows,
      alcohol_package: cruise.alcohol_package,
      wifi: cruise.wifi,
      gratuities: cruise.gratuities,
      all_tours: cruise.all_tours,
      all_dining: cruise.all_dining,
      laundry: cruise.laundry,
      onboard_credit: cruise.onboard_credit,
      other_information: cruise.other_information || "",
      outputMode
    });
  }

  function buildPayloads(cruises, outputMode) {
    return cruises.map((cruise) => ({
      name: cruise.headline || "Untitled cruise",
      model: buildModelForCruise(cruise, outputMode),
      pricingRows: issuePricingByCruiseId[cruise.id] || [],
      publicationStatus: cruise.publication_status || "draft",
      publicSlug: cruise.public_slug || ""
    }));
  }

  function cacheKey(outputMode) {
    const ids = cruisesForCurrentIssue().map((c) => c.id).join(",");
    return `${issueNumber}|${issueTemplate}|${outputMode}|${ids}|${issuePricingLoadedFor}`;
  }

  async function compose(outputMode, { soft = false } = {}) {
    if (!global.NewsletterMailchimpExport || !global.NewsletterPreview) {
      throw new Error("Mailchimp export modules failed to load.");
    }
    const cruises = cruisesForCurrentIssue();
    await ensurePricingLoaded(cruises);
    issueWarnings = collectWarnings(cruises);
    const key = cacheKey(outputMode);
    if (!soft && issueCache.key === key && issueCache[outputMode === "airline_staff" ? "airline" : "general"]) {
      return issueCache[outputMode === "airline_staff" ? "airline" : "general"];
    }
    const result = global.NewsletterMailchimpExport.composeIssueHtml(buildPayloads(cruises, outputMode), {
      outputMode,
      templateKey: issueTemplate,
      newsletterNumber: issueNumber,
      softValidation: soft
    });
    if (result.ok && !soft) {
      issueCache.key = key;
      if (outputMode === "airline_staff") issueCache.airline = result;
      else issueCache.general = result;
    }
    return result;
  }

  function rerender() {
    if (typeof global.renderAdmin === "function") global.renderAdmin();
  }

  async function selectIssueNumber(value) {
    const next = value === "" || value == null ? null : Number(value);
    issueNumber = Number.isFinite(next) ? next : null;
    issueDate = issueNumber != null ? resolveIssueDate(issueNumber) : "";
    issueTemplate = issueNumber != null ? templateForNumber(issueNumber) : "green-price-cards";
    issuePricingLoadedFor = "";
    issuePricingByCruiseId = {};
    invalidateCache();
    issueMessage = "";
    addPickerOpen = false;
    try {
      const cruises = cruisesForCurrentIssue();
      await ensurePricingLoaded(cruises);
      issueWarnings = collectWarnings(cruises);
    } catch {
      issueWarnings = [];
    }
    rerender();
  }

  function setTemplate(value) {
    issueTemplate = value === "classic-editorial" ? "classic-editorial" : "green-price-cards";
    if (issueNumber != null) saveTemplateForNumber(issueNumber, issueTemplate);
    invalidateCache();
    issueMessage = `Design template set to ${issueTemplate === "classic-editorial" ? "Classic Editorial" : "Green Price Cards"}.`;
    issueMessageTone = "info";
    rerender();
  }

  async function persistOrder(orderedIds) {
    const client = global.supabaseClient;
    if (!client) throw new Error("Database client is not ready.");
    const updates = orderedIds.map((id, index) => {
      const nextOrder = index + 1;
      const local = getCruises().find((c) => c.id === id);
      if (local) local.display_order = nextOrder;
      return client.from("featured_cruises").update({ display_order: nextOrder }).eq("id", id);
    });
    const results = await Promise.all(updates);
    const failed = results.find((r) => r.error);
    if (failed) throw new Error(failed.error.message);
    invalidateCache();
  }

  function onDragStart(event, cruiseId) {
    if (!dragFromHandle) {
      event.preventDefault();
      return;
    }
    draggedCruiseId = cruiseId;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", cruiseId);
    event.currentTarget.classList.add("is-dragging");
  }

  function onDragEnd(event) {
    event.currentTarget?.classList.remove("is-dragging");
    document.querySelectorAll(".newsletter-issue-card.is-drop-target").forEach((el) => {
      el.classList.remove("is-drop-target");
    });
    draggedCruiseId = null;
    dragFromHandle = false;
  }

  function onDragHandleDown() {
    dragFromHandle = true;
  }

  function allowDrop(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const list = event.currentTarget;
    const dragged = document.querySelector(
      `.newsletter-issue-card[data-cruise-id="${CSS.escape(String(draggedCruiseId || ""))}"]`
    );
    if (!dragged || dragged.parentElement !== list) return;
    const cards = Array.from(list.querySelectorAll(".newsletter-issue-card:not(.is-dragging)"));
    const after = cards.find((card) => {
      const rect = card.getBoundingClientRect();
      return event.clientY < rect.top + rect.height / 2;
    });
    if (after) list.insertBefore(dragged, after);
    else list.appendChild(dragged);
  }

  async function onDrop(event) {
    event.preventDefault();
    const list = event.currentTarget;
    const orderedIds = Array.from(list.querySelectorAll(".newsletter-issue-card")).map(
      (card) => card.dataset.cruiseId
    );
    try {
      issueBusy = true;
      await persistOrder(orderedIds);
      issueMessage = "Cruise order saved.";
      issueMessageTone = "success";
    } catch (error) {
      issueMessage = error.message || "Could not save cruise order.";
      issueMessageTone = "error";
      if (typeof global.loadFeaturedCruises === "function") await global.loadFeaturedCruises();
    } finally {
      issueBusy = false;
      onDragEnd({ currentTarget: null });
      rerender();
    }
  }

  async function removeCruise(cruiseId) {
    const cruise = getCruises().find((c) => c.id === cruiseId);
    if (!cruise) return;
    const ok = window.confirm(
      `Remove “${cruise.headline || "this cruise"}” from Newsletter ${issueNumber}?\n\nThe cruise itself will not be deleted or unpublished.`
    );
    if (!ok) return;
    try {
      issueBusy = true;
      const { error } = await global.supabaseClient
        .from("featured_cruises")
        .update({ newsletter_number: null, newsletter_publication_date: null })
        .eq("id", cruiseId);
      if (error) throw new Error(error.message);
      cruise.newsletter_number = null;
      cruise.newsletter_publication_date = null;
      invalidateCache();
      issuePricingLoadedFor = "";
      issueMessage = "Cruise removed from this newsletter.";
      issueMessageTone = "success";
    } catch (error) {
      issueMessage = error.message || "Could not remove cruise.";
      issueMessageTone = "error";
    } finally {
      issueBusy = false;
      rerender();
    }
  }

  function openAddPicker() {
    addPickerOpen = true;
    addPickerSelected = new Set();
    rerender();
  }

  function closeAddPicker() {
    addPickerOpen = false;
    addPickerSelected = new Set();
    rerender();
  }

  function toggleAddPicker(id, checked) {
    if (checked) addPickerSelected.add(id);
    else addPickerSelected.delete(id);
    rerender();
  }

  async function confirmAddPicker() {
    const ids = [...addPickerSelected];
    if (!ids.length || issueNumber == null) {
      closeAddPicker();
      return;
    }
    try {
      issueBusy = true;
      const existing = cruisesForCurrentIssue();
      let nextOrder = existing.reduce((max, row) => Math.max(max, Number(row.display_order) || 0), 0);
      const date = issueDate || getDefaults().newsletter_publication_date || null;
      for (const id of ids) {
        nextOrder += 1;
        const { error } = await global.supabaseClient
          .from("featured_cruises")
          .update({
            newsletter_number: Number(issueNumber),
            newsletter_publication_date: date,
            display_order: nextOrder
          })
          .eq("id", id);
        if (error) throw new Error(error.message);
        const local = getCruises().find((c) => c.id === id);
        if (local) {
          local.newsletter_number = Number(issueNumber);
          local.newsletter_publication_date = date;
          local.display_order = nextOrder;
        }
      }
      invalidateCache();
      issuePricingLoadedFor = "";
      issueMessage = `Added ${ids.length} cruise${ids.length === 1 ? "" : "s"} to Newsletter ${issueNumber}.`;
      issueMessageTone = "success";
      addPickerOpen = false;
      addPickerSelected = new Set();
    } catch (error) {
      issueMessage = error.message || "Could not add cruises.";
      issueMessageTone = "error";
    } finally {
      issueBusy = false;
      rerender();
    }
  }

  async function preview(outputMode) {
    try {
      issueBusy = true;
      issueMessage = "Building preview…";
      issueMessageTone = "running";
      rerender();
      const result = await compose(outputMode, { soft: true });
      issueHtml.previewMode = outputMode;
      issueHtml.previewHtml = result.previewHtml || "";
      issueHtml.label = result.label || "";
      issueHtml.filename = result.filename || "";
      if (outputMode === "airline_staff") issueHtml.airline = result.html || "";
      else issueHtml.general = result.html || "";
      issueWarnings = [...new Set([...(issueWarnings || []), ...(result.warnings || [])])];
      if (result.ok) {
        issueMessage = `${result.label} preview ready.`;
        issueMessageTone = "success";
      } else {
        issueMessage = "Preview incomplete — see warnings below.";
        issueMessageTone = "error";
      }
    } catch (error) {
      issueMessage = error.message || "Preview failed.";
      issueMessageTone = "error";
    } finally {
      issueBusy = false;
      rerender();
    }
  }

  async function exportHtml(outputMode, action) {
    try {
      issueBusy = true;
      issueMessage = "Preparing HTML…";
      issueMessageTone = "running";
      rerender();
      const result = await compose(outputMode, { soft: false });
      if (!result.ok) {
        issueMessage = "Fix the issues below before exporting.";
        issueMessageTone = "error";
        issueWarnings = result.errors || [];
        issueHtml.previewHtml = "";
        return;
      }
      if (outputMode === "airline_staff") issueHtml.airline = result.html;
      else issueHtml.general = result.html;
      issueHtml.filename = result.filename;
      issueHtml.label = result.label;
      issueHtml.previewMode = outputMode;
      issueHtml.previewHtml = result.previewHtml;
      issueWarnings = result.warnings || [];

      if (action === "copy") {
        await navigator.clipboard.writeText(result.html);
        issueMessage = `${result.label} copied — paste into a Mailchimp Code block.`;
        issueMessageTone = "success";
      } else if (action === "download") {
        const blob = new Blob([result.html], { type: "text/html;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = result.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        issueMessage = `Downloaded ${result.filename}.`;
        issueMessageTone = "success";
      }
    } catch (error) {
      issueMessage = error.message || "Export failed.";
      issueMessageTone = "error";
    } finally {
      issueBusy = false;
      rerender();
    }
  }

  async function addCruiseToIssue(cruiseId) {
    if (issueNumber == null) {
      issueMessage = "Start a newsletter number first, then add cruises.";
      issueMessageTone = "error";
      rerender();
      return;
    }
    try {
      issueBusy = true;
      const existing = cruisesForCurrentIssue();
      const nextOrder =
        existing.reduce((max, row) => Math.max(max, Number(row.display_order) || 0), 0) + 1;
      const date = issueDate || getDefaults().newsletter_publication_date || null;
      const { error } = await global.supabaseClient
        .from("featured_cruises")
        .update({
          newsletter_number: Number(issueNumber),
          newsletter_publication_date: date,
          display_order: nextOrder
        })
        .eq("id", cruiseId);
      if (error) throw new Error(error.message);
      const local = getCruises().find((c) => c.id === cruiseId);
      if (local) {
        local.newsletter_number = Number(issueNumber);
        local.newsletter_publication_date = date;
        local.display_order = nextOrder;
      }
      invalidateCache();
      issuePricingLoadedFor = "";
      issueMessage = `Added “${local?.headline || "cruise"}” to Newsletter ${issueNumber}.`;
      issueMessageTone = "success";
    } catch (error) {
      issueMessage = error.message || "Could not add cruise.";
      issueMessageTone = "error";
    } finally {
      issueBusy = false;
      rerender();
    }
  }

  function renderUnassignedSection() {
    const orphaned = unnumberedCruises();
    if (!orphaned.length) return "";
    return `
      <section class="newsletter-issue-section">
        <div class="admin-list-top">
          <h4>Cruises not in a newsletter yet</h4>
          <span class="admin-pill">${orphaned.length}</span>
        </div>
        <p class="admin-muted">These cruises still exist. They just do not have a newsletter number assigned, so they did not appear in an issue.</p>
        <div class="newsletter-issue-unassigned-list">
          ${orphaned
            .map((cruise) => {
              const id = esc(cruise.id);
              const line = cruise.ci_cruise_lines?.name || "Cruise line not set";
              const ship = cruise.ci_cruise_ships?.name || "Ship not set";
              return `
              <article class="newsletter-issue-card newsletter-issue-card--static">
                <button type="button" class="newsletter-issue-card-main" onclick="editFeaturedCruise('${id}')">
                  <span class="newsletter-issue-thumb" aria-hidden="true">
                    ${heroThumbUrl(cruise) ? `<img src="${esc(heroThumbUrl(cruise))}" alt="">` : ""}
                  </span>
                  <span class="newsletter-issue-card-copy">
                    <strong>${esc(cruise.headline || "Untitled cruise")}</strong>
                    <span class="admin-muted">${esc(line)} · ${esc(ship)}</span>
                    <span class="admin-small">Departure ${esc(formatDate(cruise.departure_date))}</span>
                  </span>
                </button>
                <div class="admin-actions-row">
                  <button type="button" class="admin-button secondary small" onclick="editFeaturedCruise('${id}')">Open</button>
                  <button type="button" class="admin-button black small" onclick="NewsletterIssueComposer.addCruiseToIssue('${id}')" ${issueBusy || issueNumber == null ? "disabled" : ""}>${issueNumber == null ? "Start issue first" : "Add to this issue"}</button>
                </div>
              </article>`;
            })
            .join("")}
        </div>
      </section>
    `;
  }

  function renderStartIssuePanel() {
    if (issueNumber != null) return "";
    const defaults = getDefaults();
    const suggestedNumber = defaults.newsletter_number || "";
    const suggestedDate = defaults.newsletter_publication_date || "";
    const orphanCount = unnumberedCruises().length;
    return `
      <div class="admin-message admin-error" style="margin:0 0 14px">
        No newsletter issue is selected yet${orphanCount ? ` — but ${orphanCount} existing cruise${orphanCount === 1 ? "" : "s"} ${orphanCount === 1 ? "was" : "were"} found without a newsletter number` : ""}.
        Enter a newsletter number below to start, then add those cruises to the issue.
      </div>
      <div class="newsletter-issue-start">
        <div class="admin-field">
          <label for="newsletterStartNumber">Start Newsletter Number</label>
          <input id="newsletterStartNumber" type="number" min="1" step="1" value="${esc(String(suggestedNumber || ""))}" placeholder="77">
        </div>
        <div class="admin-field">
          <label for="newsletterStartDate">Issue Date</label>
          <input id="newsletterStartDate" type="date" value="${esc(suggestedDate || "")}">
        </div>
        <div class="admin-field" style="align-self:end">
          <button type="button" class="admin-button black" onclick="NewsletterIssueComposer.startIssue()" ${issueBusy ? "disabled" : ""}>Start newsletter issue</button>
        </div>
      </div>
    `;
  }

  function renderAddPicker() {
    if (!addPickerOpen) return "";
    const rows = unassignedCruises();
    return `
      <div class="newsletter-issue-picker-overlay" onclick="if(event.target===this) NewsletterIssueComposer.closeAddPicker()">
        <div class="newsletter-issue-picker" role="dialog" aria-modal="true" aria-label="Add cruises to newsletter">
          <div class="admin-list-top">
            <div>
              <h3>Add Cruise</h3>
              <p class="admin-muted">Select cruises not already in Newsletter ${esc(String(issueNumber))}.</p>
            </div>
            <button type="button" class="admin-button secondary small" onclick="NewsletterIssueComposer.closeAddPicker()">Close</button>
          </div>
          <div class="newsletter-issue-picker-list">
            ${
              rows.length
                ? rows
                    .map((row) => {
                      const checked = addPickerSelected.has(row.id);
                      return `<label class="newsletter-issue-picker-row">
                        <input type="checkbox" ${checked ? "checked" : ""} onchange="NewsletterIssueComposer.toggleAddPicker('${esc(row.id)}', this.checked)">
                        <span>
                          <strong>${esc(row.headline || "Untitled")}</strong>
                          <span class="admin-muted">${esc(row.ci_cruise_lines?.name || "—")} · ${esc(formatDate(row.departure_date))}${
                            row.newsletter_number != null && row.newsletter_number !== ""
                              ? ` · currently Newsletter ${esc(String(row.newsletter_number))}`
                              : ""
                          }</span>
                        </span>
                      </label>`;
                    })
                    .join("")
                : `<p class="admin-muted">${
                    getCruises().length
                      ? "Every existing cruise is already in this newsletter (or archived)."
                      : "No Featured Cruises were found in the database. Use + New Cruise to create one, or check that cruises were saved under Newsletter."
                  }</p>
                  <p class="admin-helper">Loaded cruises: ${esc(String(getCruises().length))} · In this issue: ${esc(String(cruisesForCurrentIssue().length))} · Available to add: 0</p>`
            }
          </div>
          <div class="admin-actions-row">
            <button type="button" class="admin-button black" onclick="NewsletterIssueComposer.confirmAddPicker()" ${!addPickerSelected.size || issueBusy ? "disabled" : ""}>Add selected</button>
          </div>
        </div>
      </div>
    `;
  }

  function renderCruiseCard(cruise) {
    const thumb = heroThumbUrl(cruise);
    const line = cruise.ci_cruise_lines?.name || "Cruise line not set";
    const ship = cruise.ci_cruise_ships?.name || "Ship not set";
    const status = cruise.publication_status || "draft";
    const id = esc(cruise.id);
    return `
      <article
        class="newsletter-issue-card"
        data-cruise-id="${id}"
        draggable="true"
        ondragstart="NewsletterIssueComposer.onDragStart(event, '${id}')"
        ondragend="NewsletterIssueComposer.onDragEnd(event)"
      >
        <button type="button" class="newsletter-issue-handle" aria-label="Drag to reorder" onmousedown="NewsletterIssueComposer.onDragHandleDown()" title="Drag to reorder">☰</button>
        <button type="button" class="newsletter-issue-card-main" onclick="editFeaturedCruise('${id}')">
          <span class="newsletter-issue-thumb" aria-hidden="true">
            ${thumb ? `<img src="${esc(thumb)}" alt="">` : ""}
          </span>
          <span class="newsletter-issue-card-copy">
            <strong>${esc(cruise.headline || "Untitled cruise")}</strong>
            <span class="admin-muted">${esc(line)} · ${esc(ship)}</span>
            <span class="admin-small">Departure ${esc(formatDate(cruise.departure_date))} · <span class="featured-status-pill status-${esc(status)}">${esc(typeof global.featuredStatusLabel === "function" ? global.featuredStatusLabel(status) : status)}</span></span>
          </span>
        </button>
        <button type="button" class="admin-button secondary small" onclick="NewsletterIssueComposer.removeCruise('${id}')" ${issueBusy ? "disabled" : ""}>Remove</button>
      </article>
    `;
  }

  function render() {
    ensureIssueSelected();
    const numbers = availableNewsletterNumbers();
    const cruises = cruisesForCurrentIssue();
    if (!issueWarnings.length && cruises.length && Object.keys(issuePricingByCruiseId).length) {
      issueWarnings = collectWarnings(cruises);
    }
    const status = issueStatus(cruises, issueWarnings);
    const msgClass =
      issueMessageTone === "error"
        ? "admin-error"
        : issueMessageTone === "success"
          ? "admin-success"
          : issueMessageTone === "running"
            ? "admin-running"
            : "";

    return `
      <div class="admin-card newsletter-issue-composer">
        <div class="admin-list-top">
          <div>
            <h3>Newsletter${issueNumber != null ? ` ${esc(String(issueNumber))}` : ""}</h3>
            <p class="admin-muted">Assemble cruises into one Mailchimp-ready issue. Edit individual cruise content by opening a card.</p>
          </div>
          <div class="admin-actions-row">
            <button type="button" class="admin-button secondary" onclick="startNewFeaturedCruise()" ${issueBusy ? "disabled" : ""}>+ New Cruise</button>
          </div>
        </div>

        <div class="newsletter-issue-header">
          <div class="admin-field">
            <label for="newsletterIssueNumber">Newsletter Number</label>
            <select id="newsletterIssueNumber" onchange="NewsletterIssueComposer.selectIssueNumber(this.value)" ${issueBusy || !numbers.length ? "disabled" : ""}>
              ${
                numbers.length
                  ? numbers
                      .map(
                        (n) =>
                          `<option value="${esc(String(n))}" ${Number(n) === Number(issueNumber) ? "selected" : ""}>${esc(String(n))}</option>`
                      )
                      .join("")
                  : `<option value="">No issues yet</option>`
              }
            </select>
          </div>
          <div class="admin-field newsletter-issue-date-field">
            <label>Issue Date</label>
            <div class="newsletter-issue-date-row">
              <div class="newsletter-issue-static">${esc(issueDate ? formatDate(issueDate) : "—")}</div>
              <button type="button" class="admin-button secondary small" onclick="NewsletterIssueComposer.printRecord()" ${issueBusy || issueNumber == null || !cruises.length ? "disabled" : ""}>Print</button>
            </div>
          </div>
          <div class="admin-field">
            <label for="newsletterIssueTemplate">Design Template</label>
            <select id="newsletterIssueTemplate" onchange="NewsletterIssueComposer.setTemplate(this.value)" ${issueBusy || issueNumber == null ? "disabled" : ""}>
              <option value="classic-editorial" ${issueTemplate === "classic-editorial" ? "selected" : ""}>Classic Editorial</option>
              <option value="green-price-cards" ${issueTemplate === "green-price-cards" ? "selected" : ""}>Green Price Cards</option>
            </select>
          </div>
          <div class="admin-field">
            <label>Status</label>
            <div class="newsletter-issue-static"><span class="newsletter-issue-status status-${esc(status.key)}">${esc(status.label)}</span></div>
          </div>
        </div>
        <p class="admin-helper newsletter-issue-header-note">Temporary: design template is remembered in this browser only until newsletter issues get a database field.</p>

        ${renderStartIssuePanel()}

        ${issueMessage ? `<div class="admin-message ${msgClass}">${esc(issueMessage)}</div>` : ""}
        ${
          issueWarnings.length
            ? `<ul class="newsletter-issue-warnings">${issueWarnings
                .map((w) => `<li>${esc(w)}</li>`)
                .join("")}</ul>`
            : ""
        }

        ${renderUnassignedSection()}

        <section class="newsletter-issue-section">
          <div class="admin-list-top">
            <h4>Cruises in this issue</h4>
            <button type="button" class="admin-button secondary small" onclick="NewsletterIssueComposer.openAddPicker()" ${issueBusy || issueNumber == null ? "disabled" : ""}>+ Add Cruise</button>
          </div>
          ${
            !cruises.length
              ? `<p class="admin-muted">No cruises assigned to this newsletter yet. Add an existing cruise or create a new one with this newsletter number.</p>`
              : `<div class="newsletter-issue-list" ondragover="NewsletterIssueComposer.allowDrop(event)" ondrop="NewsletterIssueComposer.onDrop(event)">
                  ${cruises.map(renderCruiseCard).join("")}
                </div>
                <p class="admin-helper">Drag ☰ to reorder. Order is saved automatically and used for preview and export.</p>`
          }
        </section>

        <section class="newsletter-issue-section newsletter-issue-actions">
          <h4>Preview</h4>
          <div class="admin-actions-row">
            <button type="button" class="admin-button secondary" onclick="NewsletterIssueComposer.preview('airline_staff')" ${issueBusy || !cruises.length ? "disabled" : ""}>Preview Airline Newsletter</button>
            <button type="button" class="admin-button secondary" onclick="NewsletterIssueComposer.preview('general')" ${issueBusy || !cruises.length ? "disabled" : ""}>Preview General Newsletter</button>
          </div>
        </section>

        <section class="newsletter-issue-section newsletter-issue-actions">
          <h4>Export</h4>
          <div class="admin-actions-row">
            <button type="button" class="admin-button secondary" onclick="NewsletterIssueComposer.exportHtml('airline_staff','copy')" ${issueBusy || !cruises.length ? "disabled" : ""}>Copy Airline HTML</button>
            <button type="button" class="admin-button secondary" onclick="NewsletterIssueComposer.exportHtml('general','copy')" ${issueBusy || !cruises.length ? "disabled" : ""}>Copy General HTML</button>
          </div>
          <div class="admin-actions-row" style="margin-top:8px">
            <button type="button" class="admin-button secondary" onclick="NewsletterIssueComposer.exportHtml('airline_staff','download')" ${issueBusy || !cruises.length ? "disabled" : ""}>Download Airline HTML</button>
            <button type="button" class="admin-button secondary" onclick="NewsletterIssueComposer.exportHtml('general','download')" ${issueBusy || !cruises.length ? "disabled" : ""}>Download General HTML</button>
          </div>
          <p class="admin-helper">Export includes every cruise in this issue, in list order, using the selected design template. Each cruise must be <strong>Published</strong> with a Public Slug, hero, map and pricing so Explore More opens <code>https://www.101cruise.com.au/cruise?slug={slug}</code>.</p>
        </section>

        ${
          issueHtml.previewHtml
            ? `<section class="newsletter-issue-section">
                <p class="admin-helper"><strong>${esc(issueHtml.label || "Preview")}</strong>${issueHtml.filename ? ` · <code>${esc(issueHtml.filename)}</code>` : ""}</p>
                <div class="mailchimp-poc-preview newsletter-issue-preview">${issueHtml.previewHtml}</div>
              </section>`
            : ""
        }
      </div>
      ${renderAddPicker()}
    `;
  }

  function onCruisesReloaded() {
    issuePricingLoadedFor = "";
    invalidateCache();
    ensureIssueSelected();
    const cruises = cruisesForCurrentIssue();
    ensurePricingLoaded(cruises)
      .then(() => {
        issueWarnings = collectWarnings(cruises);
        rerender();
      })
      .catch(() => {});
  }

  global.NewsletterIssueComposer = {
    render,
    onCruisesReloaded,
    getSelectedIssue() {
      ensureIssueSelected();
      return { number: issueNumber, date: issueDate, template: issueTemplate };
    },
    selectIssueNumber,
    startIssue,
    setTemplate,
    openAddPicker,
    closeAddPicker,
    toggleAddPicker,
    confirmAddPicker,
    addCruiseToIssue,
    removeCruise,
    onDragStart,
    onDragEnd,
    onDragHandleDown,
    allowDrop,
    onDrop,
    preview,
    exportHtml,
    printRecord
  };
})(typeof window !== "undefined" ? window : globalThis);
