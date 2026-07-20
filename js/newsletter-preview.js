/**
 * Reusable Newsletter Preview renderer (Sprint 10A — top half).
 *
 * Designed for reuse by:
 * - Admin newsletter preview
 * - Future newsletter generation
 * - Future public landing pages
 *
 * Later sections (route map, pricing, included, footer) plug into SECTION_IDS
 * without rewriting the core renderer.
 */
(function (global) {
  "use strict";

  const SECTION_IDS = {
    DESTINATION_STRIP: "destination_strip",
    HEADLINE: "headline",
    HERO: "hero",
    DATES: "dates",
    NIGHTS_SHIP: "nights_ship",
    PORTS: "ports",
    DESCRIPTION: "description",
    // Reserved for later sprints — do not render in TOP_HALF.
    ROUTE_MAP: "route_map",
    PRICING: "pricing",
    INCLUDED: "included",
    OTHER_INFORMATION: "other_information",
    FOOTER: "footer",
    BRAND_LOGO: "brand_logo"
  };

  /** Sprint 10A: top half of the newsletter only. */
  const TOP_HALF_SECTIONS = [
    SECTION_IDS.DESTINATION_STRIP,
    SECTION_IDS.HEADLINE,
    SECTION_IDS.HERO,
    SECTION_IDS.DATES,
    SECTION_IDS.NIGHTS_SHIP,
    SECTION_IDS.PORTS,
    SECTION_IDS.DESCRIPTION
  ];

  const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

  function defaultEscape(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function parseCalendarDate(iso) {
    if (!iso) return null;
    const parts = String(iso).split("-").map(Number);
    if (parts.length !== 3 || parts.some((p) => !Number.isFinite(p))) return null;
    const [y, m, d] = parts;
    const dt = new Date(y, m - 1, d);
    if (Number.isNaN(dt.getTime())) return null;
    return { year: y, month: m, day: d, date: dt };
  }

  function formatNewsletterDatePart(iso) {
    const parsed = parseCalendarDate(iso);
    if (!parsed) return "";
    const dayName = DAY_NAMES[parsed.date.getDay()];
    const monthName = MONTH_NAMES[parsed.month - 1];
    return {
      label: `${dayName} ${monthName} ${parsed.day}`,
      year: parsed.year
    };
  }

  /** Example: FRI SEP 4 TO FRI SEP 11, 2026 */
  function formatNewsletterDateRange(departureDate, returnDate) {
    const start = formatNewsletterDatePart(departureDate);
    const end = formatNewsletterDatePart(returnDate);
    if (!start || !end) return "";
    if (start.year === end.year) {
      return `${start.label} TO ${end.label}, ${start.year}`;
    }
    return `${start.label}, ${start.year} TO ${end.label}, ${end.year}`;
  }

  function formatNightsShip(nights, shipName) {
    const nightsNum = Number(nights);
    const nightsLabel =
      Number.isFinite(nightsNum) && nightsNum >= 1 ? `${Math.round(nightsNum)} NIGHTS` : "";
    const ship = String(shipName || "").trim().toUpperCase();
    if (nightsLabel && ship) return `${nightsLabel} | ${ship}`;
    if (nightsLabel) return nightsLabel;
    if (ship) return ship;
    return "";
  }

  function splitPorts(itinerarySummary) {
    return String(itinerarySummary || "")
      .split("|")
      .map((part) => part.trim())
      .filter(Boolean);
  }

  function formatPortsLines(ports, longLineChars = 90) {
    if (!ports.length) return [];
    const single = ports.join(" | ");
    if (single.length <= longLineChars || ports.length < 4) return [single];
    const mid = Math.ceil(ports.length / 2);
    return [ports.slice(0, mid).join(" | "), ports.slice(mid).join(" | ")];
  }

  function splitParagraphs(text) {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);
  }

  /**
   * Build a normalised content model from Featured Cruise form/DB fields.
   * Safe to call with unsaved form state.
   */
  function buildModel(input = {}) {
    const destinationStrip = String(input.destinationStrip || input.destination_strip || "").trim().toUpperCase();
    const headline = String(input.headline || "").trim();
    const heroImageUrl = String(input.heroImageUrl || input.hero_image_url || "").trim();
    const heroImageAlt = String(input.heroImageAlt || input.hero_image_alt || headline || "Cruise image").trim();
    const departureDate = input.departureDate || input.departure_date || "";
    const returnDate = input.returnDate || input.return_date || "";
    const nights = input.nights;
    const shipName = input.shipName || input.ship_name || "";
    const itinerarySummary = String(input.itinerarySummary || input.itinerary_summary || "").trim();
    const description = String(
      input.description || input.short_editorial || input.full_description || ""
    ).trim();

    const ports = splitPorts(itinerarySummary);
    const typo = global.NewsletterTypography || {};
    const portsBody = typo.portsBody || {};

    return {
      destinationStrip: destinationStrip || "",
      headline,
      heroImageUrl,
      heroImageAlt,
      datesLine: formatNewsletterDateRange(departureDate, returnDate),
      nightsShipLine: formatNightsShip(nights, shipName),
      portsHeading: "PORTS OF CALL:",
      portsLines: formatPortsLines(ports, portsBody.longLineChars || 90),
      portsJoined: ports.join(" | "),
      description,
      descriptionParagraphs: splitParagraphs(description),
      // Future-facing placeholders (unused in TOP_HALF)
      routeMapUrl: input.routeMapUrl || null,
      pricingRows: input.pricingRows || [],
      inclusions: input.inclusions || null,
      otherInformation: input.otherInformation || input.other_information || "",
      footer: input.footer || null
    };
  }

  function styleFromToken(token = {}) {
    const parts = [];
    if (token.fontFamily) parts.push(`font-family:${token.fontFamily}`);
    if (token.fontSizePx != null) parts.push(`font-size:${token.fontSizePx}px`);
    if (token.fontWeight != null) parts.push(`font-weight:${token.fontWeight}`);
    if (token.letterSpacingPx != null) parts.push(`letter-spacing:${token.letterSpacingPx}px`);
    if (token.textTransform) parts.push(`text-transform:${token.textTransform}`);
    if (token.color) parts.push(`color:${token.color}`);
    if (token.textAlign) parts.push(`text-align:${token.textAlign}`);
    if (token.paragraphSpacingPx != null) parts.push(`margin:0 0 ${token.paragraphSpacingPx}px`);
    return parts.join(";");
  }

  function renderSection(sectionId, model, escapeHtml) {
    const esc = typeof escapeHtml === "function" ? escapeHtml : defaultEscape;
    const typo = global.NewsletterTypography || {};

    switch (sectionId) {
      case SECTION_IDS.DESTINATION_STRIP: {
        if (!model.destinationStrip) return "";
        return `<p class="nl-destination" style="${styleFromToken(typo.destinationStrip)}">${esc(model.destinationStrip)}</p>`;
      }
      case SECTION_IDS.HEADLINE: {
        if (!model.headline) return "";
        return `<h1 class="nl-headline" style="${styleFromToken(typo.headline)}">${esc(model.headline)}</h1>`;
      }
      case SECTION_IDS.HERO: {
        const hero = typo.heroImage || {};
        if (!model.heroImageUrl) {
          return `<div class="nl-hero nl-hero-empty" style="max-width:${hero.maxWidthPx || 600}px">No hero image selected</div>`;
        }
        return `
          <div class="nl-hero" style="max-width:${hero.maxWidthPx || 600}px">
            <div class="nl-hero-frame" style="aspect-ratio:${hero.aspectRatio || "16 / 9"}">
              <img src="${esc(model.heroImageUrl)}" alt="${esc(model.heroImageAlt)}" style="object-fit:${hero.objectFit || "cover"}">
            </div>
          </div>
        `;
      }
      case SECTION_IDS.DATES: {
        if (!model.datesLine) return "";
        return `<p class="nl-dates" style="${styleFromToken(typo.dates)}">${esc(model.datesLine)}</p>`;
      }
      case SECTION_IDS.NIGHTS_SHIP: {
        if (!model.nightsShipLine) return "";
        return `<p class="nl-nights-ship" style="${styleFromToken(typo.nightsShip)}">${esc(model.nightsShipLine)}</p>`;
      }
      case SECTION_IDS.PORTS: {
        if (!model.portsLines.length) return "";
        const lines = model.portsLines
          .map((line) => `<p class="nl-ports-line" style="${styleFromToken(typo.portsBody)}">${esc(line)}</p>`)
          .join("");
        return `
          <div class="nl-ports">
            <p class="nl-ports-heading" style="${styleFromToken(typo.portsHeading)}">${esc(model.portsHeading)}</p>
            ${lines}
          </div>
        `;
      }
      case SECTION_IDS.DESCRIPTION: {
        if (!model.descriptionParagraphs.length) return "";
        const descStyle = styleFromToken(typo.description);
        return `
          <div class="nl-description">
            ${model.descriptionParagraphs
              .map((p) => `<p class="nl-description-p" style="${descStyle}">${esc(p)}</p>`)
              .join("")}
          </div>
        `;
      }
      // Future sections intentionally return empty until implemented.
      case SECTION_IDS.ROUTE_MAP:
      case SECTION_IDS.PRICING:
      case SECTION_IDS.INCLUDED:
      case SECTION_IDS.OTHER_INFORMATION:
      case SECTION_IDS.FOOTER:
      case SECTION_IDS.BRAND_LOGO:
        return "";
      default:
        return "";
    }
  }

  /**
   * Render newsletter HTML for the given section set.
   * @param {object} model From buildModel()
   * @param {{ sections?: string[], escapeHtml?: Function, className?: string }} options
   */
  function render(model, options = {}) {
    const sections = options.sections || TOP_HALF_SECTIONS;
    const escapeHtml = options.escapeHtml || defaultEscape;
    const className = options.className || "newsletter-preview-article";
    const body = sections.map((id) => renderSection(id, model, escapeHtml)).filter(Boolean).join("\n");
    return `<article class="${escapeHtml(className)}">${body}</article>`;
  }

  function renderTopHalf(model, options = {}) {
    return render(model, { ...options, sections: TOP_HALF_SECTIONS });
  }

  function renderWarnings(warnings, escapeHtml) {
    const esc = typeof escapeHtml === "function" ? escapeHtml : defaultEscape;
    if (!warnings || !warnings.length) return "";
    return `
      <div class="newsletter-preview-warnings" role="status">
        ${warnings
          .map(
            (w) =>
              `<p class="newsletter-preview-warning">${esc(w.message || "")}</p>`
          )
          .join("")}
      </div>
    `;
  }

  global.NewsletterPreview = {
    SECTION_IDS,
    TOP_HALF_SECTIONS,
    buildModel,
    render,
    renderTopHalf,
    renderSection,
    renderWarnings,
    formatNewsletterDateRange,
    formatNightsShip,
    splitPorts
  };
})(typeof window !== "undefined" ? window : globalThis);
