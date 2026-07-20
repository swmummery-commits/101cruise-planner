/**
 * Reusable Newsletter / Cruise Page renderer.
 *
 * Shared content model feeds:
 * - Admin newsletter preview
 * - Future newsletter generation
 * - Public dynamic cruise pages
 *
 * Do not add per-cruise footer or branding here.
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
    FULL_DESCRIPTION: "full_description",
    EXPLORE_MORE: "explore_more",
    ROUTE_MAP: "route_map",
    PRICING: "pricing",
    INCLUDED: "included",
    OTHER_INFORMATION: "other_information",
    DISCLAIMER: "disclaimer",
    ENQUIRE: "enquire",
    FOOTER: "footer",
    BRAND_LOGO: "brand_logo"
  };

  /** Complete cruise-specific newsletter presentation (no footer/branding). */
  const NEWSLETTER_CRUISE_SECTIONS = [
    SECTION_IDS.DESTINATION_STRIP,
    SECTION_IDS.HEADLINE,
    SECTION_IDS.HERO,
    SECTION_IDS.DATES,
    SECTION_IDS.NIGHTS_SHIP,
    SECTION_IDS.PORTS,
    SECTION_IDS.DESCRIPTION,
    SECTION_IDS.EXPLORE_MORE,
    SECTION_IDS.ROUTE_MAP,
    SECTION_IDS.PRICING,
    SECTION_IDS.INCLUDED,
    SECTION_IDS.OTHER_INFORMATION,
    SECTION_IDS.DISCLAIMER
  ];

  /** Public dynamic cruise page (standalone brochure). */
  const PUBLIC_PAGE_SECTIONS = [
    SECTION_IDS.DESTINATION_STRIP,
    SECTION_IDS.HEADLINE,
    SECTION_IDS.HERO,
    SECTION_IDS.DATES,
    SECTION_IDS.NIGHTS_SHIP,
    SECTION_IDS.PORTS,
    SECTION_IDS.FULL_DESCRIPTION,
    SECTION_IDS.ROUTE_MAP,
    SECTION_IDS.PRICING,
    SECTION_IDS.INCLUDED,
    SECTION_IDS.OTHER_INFORMATION,
    SECTION_IDS.DISCLAIMER,
    SECTION_IDS.ENQUIRE
  ];

  /** @deprecated use NEWSLETTER_CRUISE_SECTIONS — kept for callers */
  const TOP_HALF_SECTIONS = NEWSLETTER_CRUISE_SECTIONS;

  const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const DISCLAIMER_TEXT = "All prices are per person in USD and subject to availability";

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
    return {
      label: `${DAY_NAMES[parsed.date.getDay()]} ${MONTH_NAMES[parsed.month - 1]} ${parsed.day}`,
      year: parsed.year
    };
  }

  function formatNewsletterDateRange(departureDate, returnDate) {
    const start = formatNewsletterDatePart(departureDate);
    const end = formatNewsletterDatePart(returnDate);
    if (!start || !end) return "";
    if (start.year === end.year) return `${start.label} TO ${end.label}, ${start.year}`;
    return `${start.label}, ${start.year} TO ${end.label}, ${end.year}`;
  }

  function formatNightsShip(nights, cruiseLineName, shipName) {
    const nightsNum = Number(nights);
    const nightsLabel =
      Number.isFinite(nightsNum) && nightsNum >= 1 ? `${Math.round(nightsNum)} NIGHTS` : "";
    const line = String(cruiseLineName || "").trim().toUpperCase();
    const ship = String(shipName || "").trim().toUpperCase();
    const vessel = [line, ship].filter(Boolean).join(" ");
    if (nightsLabel && vessel) return `${nightsLabel} | ${vessel}`;
    if (nightsLabel) return nightsLabel;
    if (vessel) return vessel;
    return "";
  }

  function splitPorts(itinerarySummary) {
    return String(itinerarySummary || "")
      .split("|")
      .map((part) => part.trim())
      .filter(Boolean);
  }

  function formatPortsJoined(ports) {
    return ports.join(" | ");
  }

  function splitParagraphs(text) {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);
  }

  function buildLandingPageUrl(input = {}) {
    if (input.landingPageUrl) return String(input.landingPageUrl).trim();
    const slug = String(input.publicSlug || input.public_slug || "").trim();
    if (!slug) return "";
    return `/cruise/${slug}`;
  }

  function shared() {
    return global.NewsletterCruiseShared || null;
  }

  /**
   * Canonical content model from Featured Cruise form/DB/public payload.
   */
  function buildModel(input = {}) {
    const destinationStrip = String(input.destinationStrip || input.destination_strip || "")
      .trim()
      .toUpperCase();
    const headline = String(input.headline || "").trim();
    const heroResolved = input.hero || null;
    const routeResolved = input.routeMap || input.route_map || null;
    const heroImageUrl = String(
      heroResolved?.url || input.heroImageUrl || input.hero_image_url || ""
    ).trim();
    const heroImageAlt = String(
      input.heroImageAlt ||
        input.hero_image_alt ||
        heroResolved?.altText ||
        heroResolved?.alt_text ||
        headline ||
        "Cruise image"
    ).trim();
    const heroImageWidth =
      heroResolved?.width ?? input.heroImageWidth ?? input.hero_image_width ?? null;
    const heroImageHeight =
      heroResolved?.height ?? input.heroImageHeight ?? input.hero_image_height ?? null;
    const heroImageSource = String(
      heroResolved?.source || input.heroImageSource || input.hero_image_source || ""
    ).trim();
    const departureDate = input.departureDate || input.departure_date || "";
    const returnDate = input.returnDate || input.return_date || "";
    const nights = input.nights;
    const cruiseLineName = input.cruiseLineName || input.cruise_line_name || "";
    const shipName = input.shipName || input.ship_name || "";
    const itinerarySummary = String(input.itinerarySummary || input.itinerary_summary || "").trim();
    const teaser = String(input.description || input.short_editorial || "").trim();
    const fullEditorial = String(
      input.fullDescription || input.full_description || teaser || ""
    ).trim();
    const otherInformation = String(input.otherInformation || input.other_information || "").trim();
    const routeMapUrl = String(
      routeResolved?.url || input.routeMapUrl || input.route_map_image_url || ""
    ).trim();
    const routeMapWidth = routeResolved?.width ?? input.routeMapWidth ?? null;
    const routeMapHeight = routeResolved?.height ?? input.routeMapHeight ?? null;
    const routeMapAlt = String(
      routeResolved?.altText || routeResolved?.alt_text || "Route map"
    ).trim();
    const landingPageUrl = buildLandingPageUrl(input);
    const outputMode =
      input.outputMode ||
      input.pricingOutputMode ||
      (shared()?.OUTPUT_MODE?.GENERAL || "general");
    const ports = splitPorts(itinerarySummary);

    const inclusionSource = input.inclusions || {
      alcohol_package: input.alcohol_package,
      wifi: input.wifi,
      gratuities: input.gratuities,
      all_tours: input.all_tours,
      all_dining: input.all_dining,
      laundry: input.laundry,
      onboard_credit: input.onboard_credit
    };

    const pricingRows = input.pricingRows || input.pricing || [];
    const pricingModules = shared()
      ? shared().buildPricingModules(pricingRows, nights, { outputMode })
      : [];
    const inclusionItems = shared() ? shared().buildInclusionItems(inclusionSource) : [];
    const enquireUrl =
      input.enquireUrl ||
      (shared()
        ? shared().buildEnquiryMailto({
            headline,
            cruise_line_name: cruiseLineName,
            ship_name: shipName,
            departure_date: departureDate,
            public_slug: input.publicSlug || input.public_slug || ""
          })
        : "");

    return {
      destinationStrip: destinationStrip || "",
      headline,
      heroImageUrl,
      heroImageAlt,
      heroImageWidth,
      heroImageHeight,
      heroImageSource,
      datesLine: formatNewsletterDateRange(departureDate, returnDate),
      nightsShipLine: formatNightsShip(nights, cruiseLineName, shipName),
      portsHeading: "PORTS OF CALL:",
      portsJoined: formatPortsJoined(ports),
      description: teaser,
      descriptionParagraphs: splitParagraphs(teaser),
      fullDescription: fullEditorial,
      fullDescriptionParagraphs: splitParagraphs(fullEditorial),
      exploreMoreLabel: "EXPLORE MORE",
      landingPageUrl,
      routeMapUrl,
      routeMapWidth,
      routeMapHeight,
      routeMapAlt,
      pricingModules,
      inclusionItems,
      otherInformation,
      disclaimerText: DISCLAIMER_TEXT,
      enquireUrl,
      enquireHeading: "READY TO EXPLORE THIS CRUISE?",
      enquireLabel: "ENQUIRE NOW",
      outputMode,
      nights,
      cruiseLineName,
      shipName,
      publicSlug: String(input.publicSlug || input.public_slug || "").trim()
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
    if (token.maxWidthPx != null) parts.push(`max-width:${token.maxWidthPx}px`);
    if (token.marginBottomPx != null) parts.push(`margin-bottom:${token.marginBottomPx}px`);
    if (token.marginTopPx != null) parts.push(`margin-top:${token.marginTopPx}px`);
    if (token.paragraphSpacingPx != null) parts.push(`margin:0 0 ${token.paragraphSpacingPx}px`);
    return parts.join(";");
  }

  function money(sharedApi, value) {
    return sharedApi ? sharedApi.formatMoney(value) : String(Math.round(Number(value) || 0));
  }

  function renderPriceMetrics(display, sharedApi, esc) {
    if (!display) return "";
    const bits = [];
    if (display.showPerDay && display.perDay != null) {
      bits.push(`$${money(sharedApi, display.perDay)}/day`);
    }
    if (display.saveAmount != null) {
      bits.push(`Save $${money(sharedApi, display.saveAmount)}`);
    }
    if (display.showPercentOff && display.percentOff != null) {
      bits.push(`${display.percentOff}% off`);
    }
    if (display.greatDeal) bits.push("GREAT DEAL");
    if (!bits.length) return "";
    return `<div class="nl-price-metrics">${esc(bits.join(" · "))}</div>`;
  }

  function renderPricingModule(mod, sharedApi, esc) {
    const brochure =
      mod.brochurePrice != null
        ? `<div class="nl-price-brochure">$${money(sharedApi, mod.brochurePrice)}</div>`
        : "";
    const airline =
      mod.airlinePrice != null
        ? `<div class="nl-price-offer">
            <div class="nl-price-offer-label">Airline</div>
            <div class="nl-price-offer-value">$${money(sharedApi, mod.airlinePrice)}</div>
            ${renderPriceMetrics(mod.airlineDisplay, sharedApi, esc)}
          </div>`
        : "";
    const cruise101 =
      mod.cruise101Price != null
        ? `<div class="nl-price-offer">
            <div class="nl-price-offer-label">101cruise</div>
            <div class="nl-price-offer-value">$${money(sharedApi, mod.cruise101Price)}</div>
            ${renderPriceMetrics(mod.cruise101Display, sharedApi, esc)}
          </div>`
        : "";

    return `
      <div class="nl-price-module">
        <div class="nl-price-room">${esc(mod.roomLabel)}</div>
        ${brochure}
        ${airline}
        ${cruise101}
      </div>
    `;
  }

  function renderSection(sectionId, model, escapeHtml) {
    const esc = typeof escapeHtml === "function" ? escapeHtml : defaultEscape;
    const typo = global.NewsletterTypography || {};
    const spacing = typo.spacing || {};
    const sharedApi = shared();

    switch (sectionId) {
      case SECTION_IDS.DESTINATION_STRIP: {
        if (!model.destinationStrip) return "";
        const token = {
          ...(typo.destinationStrip || {}),
          marginBottomPx:
            typo.destinationStrip?.marginBottomPx || spacing.destinationToHeadlinePx || 52
        };
        return `<p class="nl-destination" style="${styleFromToken(token)}">${esc(model.destinationStrip)}</p>`;
      }
      case SECTION_IDS.HEADLINE: {
        if (!model.headline) return "";
        return `<h1 class="nl-headline" style="${styleFromToken(typo.headline)}">${esc(model.headline)}</h1>`;
      }
      case SECTION_IDS.HERO: {
        const hero = typo.heroImage || {};
        const marginBottom = hero.marginBottomPx || spacing.heroToDatesPx || 36;
        if (!model.heroImageUrl) {
          return `<div class="nl-hero nl-hero-empty" style="max-width:${hero.maxWidthPx || 600}px;margin-bottom:${marginBottom}px">No hero image selected</div>`;
        }
        const dimAttrs = [
          model.heroImageWidth != null ? `width="${esc(model.heroImageWidth)}"` : "",
          model.heroImageHeight != null ? `height="${esc(model.heroImageHeight)}"` : ""
        ]
          .filter(Boolean)
          .join(" ");
        return `
          <div class="nl-hero" style="max-width:${hero.maxWidthPx || 600}px;margin-bottom:${marginBottom}px">
            <div class="nl-hero-frame" style="aspect-ratio:${hero.aspectRatio || "16 / 9"}">
              <img src="${esc(model.heroImageUrl)}" alt="${esc(model.heroImageAlt)}" ${dimAttrs} style="object-fit:${hero.objectFit || "cover"}">
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
        if (!model.portsJoined) return "";
        const headingStyle = styleFromToken({ ...(typo.portsHeading || {}), textAlign: undefined });
        const bodyStyle = styleFromToken({ ...(typo.portsBody || {}), textAlign: undefined });
        return `
          <p class="nl-ports">
            <span class="nl-ports-heading" style="${headingStyle}">${esc(model.portsHeading)}</span>
            <span class="nl-ports-body" style="${bodyStyle}"> ${esc(model.portsJoined)}</span>
          </p>
        `;
      }
      case SECTION_IDS.DESCRIPTION: {
        if (!model.descriptionParagraphs.length) return "";
        const descToken = typo.description || {};
        const divider = typo.editorialDivider || {};
        const portsToDivider = divider.marginTopPx || spacing.portsToDividerPx || 34;
        const dividerToTeaser = divider.marginBottomPx || spacing.dividerToDescriptionPx || 34;
        const descStyle = styleFromToken({ ...descToken, marginTopPx: undefined });
        return `
          <div class="nl-story-break" style="margin-top:${portsToDivider}px;margin-bottom:${dividerToTeaser}px" aria-hidden="true">
            <hr class="nl-editorial-divider" style="border:none;border-top:1px solid ${divider.color || "#E8E8E8"};height:0;margin:0;width:100%">
          </div>
          <div class="nl-description">
            ${model.descriptionParagraphs
              .map((p) => `<p class="nl-description-p" style="${descStyle}">${esc(p)}</p>`)
              .join("")}
          </div>
        `;
      }
      case SECTION_IDS.FULL_DESCRIPTION: {
        const paragraphs = model.fullDescriptionParagraphs?.length
          ? model.fullDescriptionParagraphs
          : model.descriptionParagraphs;
        if (!paragraphs?.length) return "";
        const divider = typo.editorialDivider || {};
        const portsToDivider = divider.marginTopPx || spacing.portsToDividerPx || 34;
        const dividerToTeaser = divider.marginBottomPx || spacing.dividerToDescriptionPx || 34;
        const descStyle = styleFromToken({ ...(typo.description || {}), marginTopPx: undefined });
        return `
          <div class="nl-story-break" style="margin-top:${portsToDivider}px;margin-bottom:${dividerToTeaser}px" aria-hidden="true">
            <hr class="nl-editorial-divider" style="border:none;border-top:1px solid ${divider.color || "#E8E8E8"};height:0;margin:0;width:100%">
          </div>
          <div class="nl-description nl-full-description">
            ${paragraphs.map((p) => `<p class="nl-description-p" style="${descStyle}">${esc(p)}</p>`).join("")}
          </div>
        `;
      }
      case SECTION_IDS.EXPLORE_MORE: {
        const cta = typo.exploreMore || {};
        const href = model.landingPageUrl || "#";
        const disabled = !model.landingPageUrl;
        const marginTop = cta.marginTopPx || spacing.descriptionToCtaPx || 48;
        return `
          <div class="nl-explore-more" style="margin-top:${marginTop}px">
            <a
              class="nl-explore-more-btn${disabled ? " is-disabled" : ""}"
              href="${esc(href)}"
              ${disabled ? 'aria-disabled="true" tabindex="-1" onclick="return false;"' : 'target="_blank" rel="noopener noreferrer"'}
              style="font-family:${cta.fontFamily || "Helvetica, Arial, sans-serif"};font-size:${cta.fontSizePx || 13}px;font-weight:${cta.fontWeight || 700};letter-spacing:${cta.letterSpacingPx || 1.5}px;text-transform:uppercase;background:${cta.background || "#8DD9BF"};color:${cta.color || "#111111"};padding:${cta.paddingYPx || 14}px ${cta.paddingXPx || 28}px"
              title="${disabled ? "Set a Public Slug to enable the landing page link" : "Open cruise landing page"}"
            >
              <span>${esc(model.exploreMoreLabel || "EXPLORE MORE")}</span>
              <span class="nl-explore-more-arrow" aria-hidden="true">→</span>
            </a>
          </div>
        `;
      }
      case SECTION_IDS.ROUTE_MAP: {
        if (model.routeMapUrl) {
          const dimAttrs = [
            model.routeMapWidth != null ? `width="${esc(model.routeMapWidth)}"` : "",
            model.routeMapHeight != null ? `height="${esc(model.routeMapHeight)}"` : ""
          ]
            .filter(Boolean)
            .join(" ");
          return `
            <div class="nl-route-map">
              <img src="${esc(model.routeMapUrl)}" alt="${esc(model.routeMapAlt || "Route map")}" class="nl-route-map-img" loading="lazy" ${dimAttrs}>
            </div>
          `;
        }
        return `<div class="nl-route-map nl-route-map-empty">Route map not yet added.</div>`;
      }
      case SECTION_IDS.PRICING: {
        if (!model.pricingModules?.length) return "";
        return `
          <div class="nl-pricing">
            ${model.pricingModules.map((mod) => renderPricingModule(mod, sharedApi, esc)).join("")}
            <p class="nl-pricing-note">All prices are per person in USD</p>
          </div>
        `;
      }
      case SECTION_IDS.INCLUDED: {
        if (!model.inclusionItems?.length) return "";
        return `
          <div class="nl-included">
            <p class="nl-included-heading">INCLUDED WITH THIS CRUISE</p>
            <ul class="nl-included-list">
              ${model.inclusionItems.map((item) => `<li>${esc(item)}</li>`).join("")}
            </ul>
          </div>
        `;
      }
      case SECTION_IDS.OTHER_INFORMATION: {
        if (!model.otherInformation) return "";
        return `<p class="nl-other-information">${esc(model.otherInformation)}</p>`;
      }
      case SECTION_IDS.DISCLAIMER: {
        return `<p class="nl-disclaimer">${esc(model.disclaimerText || DISCLAIMER_TEXT)}</p>`;
      }
      case SECTION_IDS.ENQUIRE: {
        if (!model.enquireUrl) return "";
        return `
          <div class="nl-enquire">
            <p class="nl-enquire-heading">${esc(model.enquireHeading || "READY TO EXPLORE THIS CRUISE?")}</p>
            <a class="nl-enquire-btn" href="${esc(model.enquireUrl)}">${esc(model.enquireLabel || "ENQUIRE NOW")}</a>
          </div>
        `;
      }
      case SECTION_IDS.FOOTER:
      case SECTION_IDS.BRAND_LOGO:
        return "";
      default:
        return "";
    }
  }

  function render(model, options = {}) {
    const sections = options.sections || NEWSLETTER_CRUISE_SECTIONS;
    const escapeHtml = options.escapeHtml || defaultEscape;
    const className = options.className || "newsletter-preview-article";
    const body = sections.map((id) => renderSection(id, model, escapeHtml)).filter(Boolean).join("\n");
    return `<article class="${escapeHtml(className)}">${body}</article>`;
  }

  function renderTopHalf(model, options = {}) {
    return render(model, { ...options, sections: NEWSLETTER_CRUISE_SECTIONS });
  }

  function renderNewsletterCruise(model, options = {}) {
    return render(model, { ...options, sections: NEWSLETTER_CRUISE_SECTIONS });
  }

  function renderPublicCruisePage(model, options = {}) {
    return render(model, {
      ...options,
      sections: PUBLIC_PAGE_SECTIONS,
      className: options.className || "public-cruise-article"
    });
  }

  function renderWarnings(warnings, escapeHtml) {
    const esc = typeof escapeHtml === "function" ? escapeHtml : defaultEscape;
    if (!warnings || !warnings.length) return "";
    return `
      <div class="newsletter-preview-warnings" role="status">
        ${warnings.map((w) => `<p class="newsletter-preview-warning">${esc(w.message || "")}</p>`).join("")}
      </div>
    `;
  }

  global.NewsletterPreview = {
    SECTION_IDS,
    TOP_HALF_SECTIONS,
    NEWSLETTER_CRUISE_SECTIONS,
    PUBLIC_PAGE_SECTIONS,
    DISCLAIMER_TEXT,
    buildModel,
    render,
    renderTopHalf,
    renderNewsletterCruise,
    renderPublicCruisePage,
    renderSection,
    renderWarnings,
    formatNewsletterDateRange,
    formatNightsShip,
    splitPorts
  };
})(typeof window !== "undefined" ? window : globalThis);
