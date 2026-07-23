/**
 * Sprint 13A/13B — Mailchimp Code-block HTML proof of concept.
 *
 * Generates an email-safe HTML *fragment* for one cruise special
 * (Airline Staff or General) using a selectable design template:
 *   - classic-editorial  (Sprint 13A proven output — preserve)
 *   - green-price-cards  (Sprint 13B)
 *
 * Consumes the canonical NewsletterPreview model + shared pricing rules.
 * Not a full newsletter document. No Mailchimp API.
 */
(function (global) {
  "use strict";

  const SITE_ORIGIN = "https://www.101cruise.com.au";
  const MAX_WIDTH = 600;
  const MAX_ROOMS = 4;
  const BRAND_GREEN = "#8DD9BF";

  const TEMPLATES = {
    CLASSIC_EDITORIAL: "classic-editorial",
    GREEN_PRICE_CARDS: "green-price-cards"
  };

  const TEMPLATE_LABELS = {
    "classic-editorial": "Classic Editorial",
    "green-price-cards": "Green Price Cards"
  };

  const LABELS = {
    airline_staff: "Airline Staff — Mailchimp HTML",
    general: "General — Mailchimp HTML"
  };

  /** @deprecated Sprint 13A filenames — prefer filenameFor() */
  const FILENAMES = {
    airline_staff: "101cruise-mailchimp-airline-classic-editorial-poc.html",
    general: "101cruise-mailchimp-general-classic-editorial-poc.html"
  };

  function shared() {
    return global.NewsletterCruiseShared || null;
  }

  function typo() {
    return global.NewsletterTypography || {};
  }

  function escapeHtml(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function money(value) {
    const api = shared();
    if (api) return api.formatMoney(value);
    const num = Number(value);
    if (!Number.isFinite(num)) return "";
    return String(Math.round(num));
  }

  function slugifyPublicSlug(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
  }

  function isAbsoluteHttpUrl(url) {
    return /^https?:\/\//i.test(String(url || "").trim());
  }

  function isAbsoluteHttpsUrl(url) {
    return /^https:\/\//i.test(String(url || "").trim());
  }

  function isLocalOrDevUrl(url) {
    try {
      const u = new URL(String(url || "").trim());
      const host = u.hostname.toLowerCase();
      if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0") return true;
      if (host.endsWith(".local")) return true;
      if (host.endsWith(".netlify.app") && /deploy-preview|branch-deploy/i.test(host)) return true;
      return false;
    } catch {
      return true;
    }
  }

  function isAdminOrProtectedUrl(url) {
    const raw = String(url || "").trim().toLowerCase();
    if (!raw) return false;
    if (raw.includes("/admin") || raw.includes("admin.html")) return true;
    if (raw.includes("/.netlify/functions/")) return true;
    if (raw.startsWith("blob:") || raw.startsWith("data:")) return true;
    return false;
  }

  function isPublicImageUrl(url) {
    const raw = String(url || "").trim();
    if (!raw) return false;
    if (!isAbsoluteHttpUrl(raw)) return false;
    if (isLocalOrDevUrl(raw)) return false;
    if (isAdminOrProtectedUrl(raw)) return false;
    if (raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../")) return false;
    return true;
  }

  function toAbsolutePublicUrl(url, siteOrigin = SITE_ORIGIN) {
    const raw = String(url || "").trim();
    if (!raw || raw === "#") return "";
    if (isAbsoluteHttpUrl(raw)) {
      if (isLocalOrDevUrl(raw) || isAdminOrProtectedUrl(raw)) return "";
      return raw;
    }
    if (raw.startsWith("/")) {
      return String(siteOrigin || SITE_ORIGIN).replace(/\/$/, "") + raw;
    }
    return "";
  }

  /**
   * Canonical Explore More URL for the live Squarespace /cruise page.
   * Production format (Squarespace-native): https://www.101cruise.com.au/cruise?slug={slug}
   * Path form is not used for newsletter CTAs — Squarespace cannot silently rewrite /cruise/{slug}.
   */
  function buildExploreMoreUrl(model, options = {}) {
    const origin = String(options.siteOrigin || SITE_ORIGIN).replace(/\/$/, "");
    let slug = slugifyPublicSlug(model?.publicSlug || options.publicSlug || "");
    if (!slug) {
      const landing = String(model?.landingPageUrl || "").trim();
      const queryMatch = landing.match(/[?&]slug=([^&]+)/i);
      if (queryMatch) slug = slugifyPublicSlug(decodeURIComponent(queryMatch[1]));
      if (!slug) {
        const pathMatch = landing.match(/\/cruise\/([a-z0-9-]+)/i);
        if (pathMatch) slug = slugifyPublicSlug(pathMatch[1]);
      }
    }
    if (!slug) return "";
    return `${origin}/cruise?slug=${encodeURIComponent(slug)}`;
  }

  function normalizeOutputMode(mode) {
    const api = shared();
    const airline = api?.OUTPUT_MODE?.AIRLINE_STAFF || "airline_staff";
    return mode === airline ? airline : api?.OUTPUT_MODE?.GENERAL || "general";
  }

  function normalizeTemplate(templateKey) {
    const key = String(templateKey || TEMPLATES.CLASSIC_EDITORIAL).trim();
    if (key === TEMPLATES.GREEN_PRICE_CARDS) return TEMPLATES.GREEN_PRICE_CARDS;
    return TEMPLATES.CLASSIC_EDITORIAL;
  }

  function filenameFor(outputMode, templateKey) {
    const audience = outputMode === "airline_staff" ? "airline" : "general";
    const template = normalizeTemplate(templateKey);
    return `101cruise-mailchimp-${audience}-${template}-poc.html`;
  }

  function labelFor(outputMode, templateKey) {
    const audience = LABELS[outputMode] || LABELS.general;
    const template = TEMPLATE_LABELS[normalizeTemplate(templateKey)] || TEMPLATE_LABELS["classic-editorial"];
    return `${audience} · ${template}`;
  }

  function validate(model, options = {}) {
    const errors = [];
    const outputMode = normalizeOutputMode(options.outputMode || model?.outputMode);
    const templateKey = normalizeTemplate(options.templateKey || options.template);
    const includeAirline = outputMode === "airline_staff";

    if (!model) {
      errors.push("Select a cruise special before generating Mailchimp HTML.");
      return { ok: false, errors, outputMode, templateKey };
    }

    if (!String(model.headline || "").trim()) {
      errors.push("This cruise special needs a headline.");
    }
    if (!String(model.datesLine || "").trim()) {
      errors.push("Travel dates are missing. Check departure date and nights.");
    }
    if (!String(model.nightsShipLine || "").trim()) {
      errors.push("Nights, cruise line, or ship details are incomplete.");
    }
    if (!String(model.portsJoined || "").trim()) {
      errors.push("Ports of call are missing. Add an itinerary summary.");
    }
    if (!String(model.description || "").trim() && !(model.descriptionParagraphs || []).length) {
      errors.push("Short editorial / description is missing.");
    }

    if (!model.heroImageUrl) {
      errors.push("A hero image is required. Choose one from the Media Library.");
    } else if (!isPublicImageUrl(model.heroImageUrl)) {
      errors.push(
        "The hero image must use a stable public web address (https). Relative, local, or admin-only image links cannot be used in Mailchimp."
      );
    }

    // Route map is optional — omit the section when missing. If one is set,
    // it must still be a stable public https URL for Mailchimp.
    if (model.routeMapUrl && !isPublicImageUrl(model.routeMapUrl)) {
      errors.push(
        "The route map must use a stable public web address (https). Relative, local, or admin-only image links cannot be used in Mailchimp."
      );
    }

    const modules = Array.isArray(model.pricingModules) ? model.pricingModules : [];
    if (!modules.length) {
      errors.push("At least one room category with a valid price is required.");
    }

    if (includeAirline) {
      const hasAirline = modules.some((m) => m.airlinePrice != null);
      if (!hasAirline) {
        errors.push(
          "Airline Staff HTML needs at least one airline staff price. Add airline prices or generate the General version instead."
        );
      }
    }

    const slug = slugifyPublicSlug(model.publicSlug || options.publicSlug || "");
    const publicationStatus = String(
      options.publicationStatus || model.publicationStatus || model.publication_status || ""
    )
      .trim()
      .toLowerCase();
    // Soft admin previews may render drafts; hard export must not emit dead Explore More links.
    const enforcePublicPage = !options.softValidation;

    if (enforcePublicPage) {
      if (!slug || publicationStatus !== "published") {
        errors.push(
          "Public page unavailable. This cruise has not been published or has no valid public slug."
        );
      }
    } else if (!slug) {
      errors.push("Set a Public Slug so Explore More can open the live cruise page.");
    }

    const cta = buildExploreMoreUrl(model, { ...options, publicSlug: slug || options.publicSlug });
    if (!cta) {
      errors.push(
        "The Explore More link is missing or invalid. Set a Public Slug so the cruise page address can be built."
      );
    } else if (!isAbsoluteHttpsUrl(cta) || isLocalOrDevUrl(cta) || isAdminOrProtectedUrl(cta)) {
      errors.push("The Explore More link must be a full public https address.");
    }

    return { ok: errors.length === 0, errors, outputMode, templateKey, ctaUrl: cta, publicSlug: slug };
  }

  function assertFragmentSafe(html, outputMode) {
    const errors = [];
    const lower = String(html || "").toLowerCase();
    if (lower.includes("<!doctype")) errors.push("Output must not include a full HTML document (DOCTYPE).");
    if (/<html[\s>]/i.test(html)) errors.push("Output must not include an <html> tag.");
    if (/<head[\s>]/i.test(html)) errors.push("Output must not include a <head> tag.");
    if (/<body[\s>]/i.test(html)) errors.push("Output must not include a <body> tag.");
    if (/<script[\s>]/i.test(html)) errors.push("Output must not include JavaScript.");
    if (/\son[a-z]+\s*=/i.test(html)) errors.push("Output must not include JavaScript event attributes.");
    if (/src\s*=\s*["'](?!https?:\/\/)/i.test(html)) {
      errors.push("Every image must use an absolute http(s) address.");
    }
    if (/exclusive save/i.test(html)) {
      errors.push("Output must not include Exclusive Save labels.");
    }
    if (outputMode === "general") {
      if (/airline staff price/i.test(html)) {
        errors.push("General HTML must not include airline staff pricing.");
      }
    }
    return errors;
  }

  function spacerRow(heightPx) {
    const h = Math.max(0, Number(heightPx) || 0);
    return `<tr><td height="${h}" style="height:${h}px;line-height:${h}px;font-size:0;mso-line-height-rule:exactly;">&nbsp;</td></tr>`;
  }

  function textRow(innerHtml, style) {
    return `<tr><td align="center" style="${style}">${innerHtml}</td></tr>`;
  }

  function renderImage(url, alt, widthAttr) {
    const w = widthAttr || MAX_WIDTH;
    return `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt || "")}" width="${w}" border="0" style="display:block;width:100%;max-width:${MAX_WIDTH}px;height:auto;border:0;">`;
  }

  /* ─── Classic Editorial (Sprint 13A — preserve) ───────────────────────── */

  function renderClassicYouSave(display, { emphasizePercent = false } = {}) {
    if (!display || display.saveAmount == null) return "";
    const percent =
      emphasizePercent && display.showPercentOff && display.percentOff != null
        ? `<div style="font-family:Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;color:#1f7a66;margin-top:4px;">${escapeHtml(display.percentOff)}% OFF</div>`
        : "";
    return `<div style="font-family:Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;color:#111111;margin-top:6px;">YOU SAVE $${escapeHtml(money(display.saveAmount))}</div>${percent}`;
  }

  function renderClassicPricingColumn(mod, includeAirline, widthPct) {
    const brochure =
      mod.brochurePrice != null
        ? `<div style="padding:4px 0 10px;">
            <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:0.6px;color:#545454;">BROCHURE PRICE</div>
            <div style="font-family:Helvetica,Arial,sans-serif;font-size:18px;font-weight:400;color:#888888;text-decoration:line-through;">$${escapeHtml(money(mod.brochurePrice))}</div>
          </div>`
        : "";

    const cruise101 =
      mod.cruise101Price != null
        ? `<div style="padding:4px 0 10px;">
            <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:0.6px;color:#545454;">101CRUISE PRICE</div>
            <div style="font-family:Helvetica,Arial,sans-serif;font-size:22px;font-weight:700;color:#111111;">$${escapeHtml(money(mod.cruise101Price))}</div>
            ${renderClassicYouSave(mod.cruise101Display)}
          </div>`
        : "";

    const airline =
      includeAirline && mod.airlinePrice != null
        ? `<div style="padding:4px 0 10px;">
            <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:0.6px;color:#545454;">AIRLINE STAFF PRICE</div>
            <div style="font-family:Helvetica,Arial,sans-serif;font-size:22px;font-weight:700;color:#111111;">$${escapeHtml(money(mod.airlinePrice))}</div>
            ${renderClassicYouSave(mod.airlineDisplay, { emphasizePercent: true })}
          </div>`
        : "";

    const divider = (show) =>
      show
        ? `<div style="height:1px;line-height:1px;font-size:0;background-color:#e5ebe8;margin:4px 12px;">&nbsp;</div>`
        : "";

    return `
      <td class="cr101-pricing-column cr101-mobile-stack" width="${widthPct}%" valign="top" align="center" style="width:${widthPct}%;padding:28px 12px;border-right:1px solid #e5ebe8;vertical-align:top;">
        <div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;letter-spacing:0.7px;text-transform:uppercase;color:#1f7a66;margin:0 0 10px;line-height:1.3;">${escapeHtml(mod.roomLabel)}</div>
        ${brochure}
        ${cruise101 ? divider(Boolean(brochure)) : ""}
        ${cruise101}
        ${airline ? divider(Boolean(cruise101 || brochure)) : ""}
        ${airline}
      </td>
    `;
  }

  function renderClassicPricingTable(modules, includeAirline) {
    const list = (modules || []).slice(0, MAX_ROOMS);
    if (!list.length) return "";
    const widthPct = Math.floor(100 / list.length);
    const cols = list.map((mod, index) => {
      let cell = renderClassicPricingColumn(mod, includeAirline, widthPct);
      if (index === list.length - 1) {
        cell = cell.replace("border-right:1px solid #e5ebe8;", "border-right:0;");
      }
      return cell;
    });

    return `
      <tr>
        <td align="center" style="padding:44px 0 0;">
          <table role="presentation" class="cr101-pricing-table" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${MAX_WIDTH}px;border-collapse:collapse;border:1px solid #d9e0dd;background-color:#ffffff;">
            <tr>
              ${cols.join("")}
            </tr>
          </table>
        </td>
      </tr>
    `;
  }

  /** Classic Editorial CTA — green button (unchanged look); padding on <a> so the full button is clickable. */
  function renderClassicCtaButton(href, label) {
    const t = typo().exploreMore || {};
    const bg = t.background || BRAND_GREEN;
    const color = t.color || "#111111";
    const font = t.fontFamily || "Helvetica, Arial, sans-serif";
    const size = t.fontSizePx || 13;
    const weight = t.fontWeight || 700;
    const tracking = t.letterSpacingPx != null ? t.letterSpacingPx : 1.5;
    const padY = t.paddingYPx || 14;
    const padX = t.paddingXPx || 28;
    return `
      <tr>
        <td align="center" style="padding:48px 0 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="border-collapse:collapse;">
            <tr>
              <td align="center" bgcolor="${bg}" style="background-color:${bg};">
                <a href="${escapeHtml(href)}" target="_blank" style="font-family:${font};font-size:${size}px;font-weight:${weight};letter-spacing:${tracking}px;text-transform:uppercase;color:${color};text-decoration:none;display:inline-block;padding:${padY}px ${padX}px;">
                  ${escapeHtml(label || "EXPLORE MORE")} →
                </a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    `;
  }

  /* ─── Green Price Cards (Sprint 13B / 13C refinements) ─────────────────── */

  const GPC_RADIUS_PX = 8;
  const GPC_ROOM_FONT_PX = 12;
  /** Compact single-line header (1–3 rooms). */
  const GPC_HEADER_COMPACT_PX = 36;
  /** Fixed two-line-capable header (4+ rooms) for equal card alignment. */
  const GPC_HEADER_TWOLINE_PX = 52;

  function greenHeaderMode(roomCount) {
    return roomCount >= 4 ? "two-line" : "compact";
  }

  function renderGreenFareBox({ label, price, saveAmount, percentOff }) {
    const saveLine =
      saveAmount != null
        ? `<div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.4px;color:#FFFFFF;margin-top:4px;line-height:1.25;">YOU SAVE $${escapeHtml(money(saveAmount))}</div>`
        : "";
    const percentLine =
      percentOff != null
        ? `<div style="font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;letter-spacing:0.5px;color:#FFFFFF;margin-top:6px;line-height:1.2;">${escapeHtml(percentOff)}% OFF</div>`
        : "";
    return `
      <table role="presentation" class="cr101-gpc-fare" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:separate;border-radius:${GPC_RADIUS_PX}px;background-color:${BRAND_GREEN};">
        <tr>
          <td align="center" bgcolor="${BRAND_GREEN}" style="background-color:${BRAND_GREEN};border-radius:${GPC_RADIUS_PX}px;padding:10px 8px;text-align:center;">
            <div style="font-family:Helvetica,Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.7px;text-transform:uppercase;color:#FFFFFF;line-height:1.2;">${escapeHtml(label)}</div>
            <div style="font-family:Helvetica,Arial,sans-serif;font-size:22px;font-weight:700;color:#FFFFFF;line-height:1.15;margin-top:4px;">$${escapeHtml(money(price))}</div>
            ${saveLine}
            ${percentLine}
          </td>
        </tr>
      </table>
    `;
  }

  function renderGreenPricingCard(mod, includeAirline, headerMode) {
    const twoLine = headerMode === "two-line";
    const headerHeight = twoLine ? GPC_HEADER_TWOLINE_PX : GPC_HEADER_COMPACT_PX;
    const brochure =
      mod.brochurePrice != null
        ? `<div style="padding:2px 0 8px;text-align:center;">
            <div style="font-family:Helvetica,Arial,sans-serif;font-size:10px;letter-spacing:0.5px;color:#6b7280;text-transform:uppercase;">BROCHURE PRICE</div>
            <div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:400;color:#9ca3af;text-decoration:line-through;line-height:1.25;">$${escapeHtml(money(mod.brochurePrice))}</div>
          </div>`
        : "";

    const cruise101 =
      mod.cruise101Price != null
        ? renderGreenFareBox({
            label: "101CRUISE PRICE",
            price: mod.cruise101Price,
            saveAmount: mod.cruise101Display?.saveAmount ?? null,
            percentOff: null
          })
        : "";

    const airlinePercent =
      includeAirline &&
      mod.airlineDisplay &&
      mod.airlineDisplay.showPercentOff &&
      mod.airlineDisplay.percentOff != null
        ? mod.airlineDisplay.percentOff
        : null;

    const airline =
      includeAirline && mod.airlinePrice != null
        ? renderGreenFareBox({
            label: "AIRLINE STAFF PRICE",
            price: mod.airlinePrice,
            saveAmount: mod.airlineDisplay?.saveAmount ?? null,
            percentOff: airlinePercent
          })
        : "";

    const fareSpacer =
      cruise101 && airline
        ? `<tr><td height="6" style="height:6px;line-height:6px;font-size:0;mso-line-height-rule:exactly;">&nbsp;</td></tr>`
        : "";

    return `
      <table role="presentation" class="cr101-gpc-card" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:separate;border:1px solid #e5e7eb;border-radius:10px;background-color:#FFFFFF;">
        <tr>
          <td
            class="cr101-gpc-room-header"
            align="center"
            valign="middle"
            height="${headerHeight}"
            bgcolor="${BRAND_GREEN}"
            data-cr101-gpc-header-mode="${twoLine ? "two-line" : "compact"}"
            data-cr101-gpc-header-height="${headerHeight}"
            style="background-color:${BRAND_GREEN};border-radius:9px 9px 0 0;height:${headerHeight}px;padding:0 8px;text-align:center;vertical-align:middle;mso-line-height-rule:exactly;"
          >
            <div style="font-family:Helvetica,Arial,sans-serif;font-size:${GPC_ROOM_FONT_PX}px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:#FFFFFF;text-align:center;line-height:1.25;">${escapeHtml(mod.roomLabel)}</div>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:10px 10px 4px;background-color:#FFFFFF;">
            ${brochure}
          </td>
        </tr>
        ${
          cruise101
            ? `<tr>
          <td align="center" style="padding:0 10px ${airline ? "0" : "10px"};background-color:#FFFFFF;">
            ${cruise101}
          </td>
        </tr>`
            : ""
        }
        ${fareSpacer}
        ${
          airline
            ? `<tr>
          <td align="center" style="padding:0 10px 10px;background-color:#FFFFFF;">
            ${airline}
          </td>
        </tr>`
            : ""
        }
      </table>
    `;
  }

  function renderGreenPricingTable(modules, includeAirline) {
    const list = (modules || []).slice(0, MAX_ROOMS);
    if (!list.length) return "";
    const headerMode = greenHeaderMode(list.length);
    const widthPct = Math.floor(100 / list.length);
    const gapPad = list.length > 1 ? 4 : 0;
    const cols = list
      .map(
        (mod) => `
      <td class="cr101-gpc-column cr101-mobile-stack" width="${widthPct}%" valign="top" align="center" style="width:${widthPct}%;padding:0 ${gapPad}px;vertical-align:top;">
        ${renderGreenPricingCard(mod, includeAirline, headerMode)}
      </td>`
      )
      .join("");

    return `
      <tr>
        <td align="center" style="padding:32px 0 0;" data-cr101-gpc-room-count="${list.length}" data-cr101-gpc-header-mode="${headerMode}">
          <table role="presentation" class="cr101-gpc-pricing-table" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${MAX_WIDTH}px;border-collapse:collapse;">
            <tr>
              ${cols}
            </tr>
          </table>
        </td>
      </tr>
    `;
  }

  /** Green Price Cards CTA — solid black, white text, rectangular, obviously clickable. */
  function renderGreenCtaButton(href, label) {
    return `
      <tr>
        <td align="center" style="padding:40px 0 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="border-collapse:collapse;">
            <tr>
              <td align="center" bgcolor="#000000" style="background-color:#000000;border-radius:2px;">
                <a href="${escapeHtml(href)}" target="_blank" style="font-family:Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#FFFFFF;text-decoration:none;display:inline-block;padding:14px 32px;">
                  ${escapeHtml(label || "EXPLORE MORE")} →
                </a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    `;
  }

  /* ─── Shared / template-specific info bars ─────────────────────────────── */

  function renderInclusions(items, { green = false } = {}) {
    if (!items?.length) return "";
    const labels = items.map((item) => {
      if (typeof item === "string") return String(item).toUpperCase();
      return item.shortLabel || String(item.label || "").toUpperCase();
    });
    const padTop = green ? 12 : 28;
    const radius = green ? `border-radius:${GPC_RADIUS_PX}px;` : "";
    const bg = "background-color:#f4faf7;";
    return `
      <tr>
        <td align="center" style="padding:${padTop}px 0 0;">
          <table role="presentation" class="${green ? "cr101-gpc-includes" : "cr101-includes"}" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:separate;${radius}${bg}">
            <tr>
              <td align="center" style="padding:12px 14px 4px;font-family:Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#1f7a66;${bg}">
                INCLUDES
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:4px 14px 12px;font-family:Helvetica,Arial,sans-serif;font-size:12px;font-weight:400;letter-spacing:0.4px;line-height:1.55;color:#111111;${radius}${bg}">
                ${escapeHtml(labels.join(" · "))}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    `;
  }

  function renderOtherInfo(text, { green = false, bodyColor = "#111111" } = {}) {
    if (!text) return "";
    const content = escapeHtml(String(text).toUpperCase());
    if (green) {
      return `
        <tr>
          <td align="center" style="padding:8px 0 0;">
            <table role="presentation" class="cr101-gpc-other-info" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:separate;border-radius:${GPC_RADIUS_PX}px;background-color:#f7f8f8;">
              <tr>
                <td align="center" style="padding:12px 14px;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:${bodyColor};border-radius:${GPC_RADIUS_PX}px;background-color:#f7f8f8;">
                  <strong>OTHER INFO:</strong> ${content}
                </td>
              </tr>
            </table>
          </td>
        </tr>
      `;
    }
    return `
        <tr>
          <td align="center" style="padding:16px 0 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;background-color:#f7f8f8;">
              <tr>
                <td align="center" style="padding:14px;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:${bodyColor};">
                  <strong>OTHER INFO:</strong> ${content}
                </td>
              </tr>
            </table>
          </td>
        </tr>
      `;
  }

  function classicStyleBlock() {
    return `
<style type="text/css">
  @media only screen and (max-width: 620px) {
    .cr101-pricing-column,
    .cr101-mobile-stack {
      display: block !important;
      width: 100% !important;
      max-width: 100% !important;
      border-right: 0 !important;
      border-bottom: 1px solid #e5ebe8 !important;
    }
    .cr101-wrapper {
      width: 100% !important;
    }
  }
</style>
`.trim();
  }

  function greenStyleBlock() {
    return `
<style type="text/css">
  @media only screen and (max-width: 620px) {
    .cr101-gpc-column,
    .cr101-mobile-stack {
      display: block !important;
      width: 100% !important;
      max-width: 100% !important;
      padding-left: 0 !important;
      padding-right: 0 !important;
      padding-bottom: 10px !important;
    }
    .cr101-gpc-card {
      width: 100% !important;
    }
    .cr101-wrapper {
      width: 100% !important;
    }
  }
</style>
`.trim();
  }

  /**
   * Build Mailchimp Code-block fragment from a canonical newsletter model.
   */
  function renderFragment(model, options = {}) {
    const validation = validate(model, options);
    const templateKey = validation.templateKey || normalizeTemplate(options.templateKey);
    const failMeta = {
      ok: false,
      html: "",
      previewHtml: "",
      filename: filenameFor(validation.outputMode || "general", templateKey),
      label: labelFor(validation.outputMode || "general", templateKey),
      outputMode: validation.outputMode || "general",
      templateKey
    };

    if (!validation.ok) {
      return { ...failMeta, errors: validation.errors };
    }

    const outputMode = validation.outputMode;
    const includeAirline = outputMode === "airline_staff";
    const ctaUrl = validation.ctaUrl;
    const colors = typo().colors || {};
    const white = colors.white || "#ffffff";
    const body = colors.body || "#111111";
    const muted = colors.muted || "#545454";
    const black = colors.black || "#000000";
    const dividerColor = typo().editorialDivider?.color || "#E8E8E8";
    const isGreen = templateKey === TEMPLATES.GREEN_PRICE_CARDS;

    const destination = model.destinationStrip
      ? textRow(
          escapeHtml(model.destinationStrip),
          `font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:400;letter-spacing:3px;text-transform:uppercase;color:${muted};text-align:center;padding:0;`
        ) + spacerRow(38)
      : "";

    const headline = model.headline
      ? textRow(
          escapeHtml(model.headline),
          `font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:700;color:${black};text-align:center;line-height:1.35;padding:0 12px;`
        ) + spacerRow(24)
      : "";

    const hero = `
      <tr>
        <td align="center" style="padding:0 0 36px;">
          ${renderImage(model.heroImageUrl, model.heroImageAlt || model.headline || "Cruise image", MAX_WIDTH)}
        </td>
      </tr>
    `;

    const dates = model.datesLine
      ? textRow(
          escapeHtml(model.datesLine),
          `font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${black};text-align:center;padding:0 0 8px;`
        )
      : "";

    const nightsShip = model.nightsShipLine
      ? textRow(
          escapeHtml(model.nightsShipLine),
          `font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${black};text-align:center;padding:0 0 22px;`
        )
      : "";

    const ports = model.portsJoined
      ? textRow(
          `<span style="font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;text-transform:uppercase;color:${black};">PORTS OF CALL:</span> <span style="font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:400;color:${body};">${escapeHtml(model.portsJoined)}</span>`,
          "text-align:center;padding:0 8px;"
        )
      : "";

    const paragraphs = (model.descriptionParagraphs || []).filter(Boolean);
    const description = paragraphs.length
      ? `
        ${spacerRow(34)}
        <tr>
          <td align="center" style="padding:0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
              <tr><td height="1" style="height:1px;line-height:1px;font-size:0;background-color:${dividerColor};border:0;">&nbsp;</td></tr>
            </table>
          </td>
        </tr>
        ${spacerRow(34)}
        ${paragraphs
          .map(
            (p, index) =>
              textRow(
                escapeHtml(p),
                `font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:400;color:${body};text-align:center;line-height:1.65;padding:0 12px ${index === paragraphs.length - 1 ? 0 : 24}px;`
              )
          )
          .join("")}
      `
      : "";

    const cta = isGreen
      ? renderGreenCtaButton(ctaUrl, model.exploreMoreLabel || "EXPLORE MORE")
      : renderClassicCtaButton(ctaUrl, model.exploreMoreLabel || "EXPLORE MORE");

    const routeMap = model.routeMapUrl
      ? `
      <tr>
        <td align="center" style="padding:40px 0 0;">
          ${renderImage(model.routeMapUrl, model.routeMapAlt || "Route map", MAX_WIDTH)}
        </td>
      </tr>
    `
      : "";

    const pricing = isGreen
      ? renderGreenPricingTable(model.pricingModules, includeAirline)
      : renderClassicPricingTable(model.pricingModules, includeAirline);

    const inclusions = renderInclusions(model.inclusionItems, { green: isGreen });
    const otherInfo = renderOtherInfo(model.otherInformation, { green: isGreen, bodyColor: body });

    const disclaimerPadTop = 8;
    const disclaimer = textRow(
      escapeHtml(model.disclaimerText || "All prices are per person in USD and subject to availability"),
      `font-family:Helvetica,Arial,sans-serif;font-size:11px;color:${muted};text-align:center;padding:${disclaimerPadTop}px 12px 0;line-height:1.5;`
    );

    // Grey dotted rule under each cruise so stacked issue previews/exports read as separate specials.
    const cruiseSeparator = `
      <tr>
        <td align="center" style="padding:28px 16px 8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${MAX_WIDTH}px;border-collapse:collapse;">
            <tr>
              <td style="border-top:2px dotted #c4c4c4;font-size:0;line-height:0;height:0;mso-line-height-rule:exactly;">&nbsp;</td>
            </tr>
          </table>
        </td>
      </tr>
    `;

    const inner = `
      ${destination}
      ${headline}
      ${hero}
      ${dates}
      ${nightsShip}
      ${ports}
      ${description}
      ${cta}
      ${routeMap}
      ${pricing}
      ${inclusions}
      ${otherInfo}
      ${disclaimer}
      ${cruiseSeparator}
    `;

    const styleBlock = isGreen ? greenStyleBlock() : classicStyleBlock();
    const wrapperClass = isGreen ? "cr101-wrapper cr101-gpc-wrapper" : "cr101-wrapper";

    const html = `
${styleBlock}
<table role="presentation" class="cr101-outer" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;background-color:${white};" data-cr101-template="${escapeHtml(templateKey)}">
  <tr>
    <td align="center" style="padding:0;background-color:${white};">
      <table role="presentation" class="${wrapperClass}" width="${MAX_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${MAX_WIDTH}px;border-collapse:collapse;background-color:${white};">
        <tr>
          <td align="center" style="padding:24px 16px;background-color:${white};">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
              ${inner}
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
`.trim();

    const safety = assertFragmentSafe(html, outputMode);
    if (safety.length) {
      return { ...failMeta, errors: safety, outputMode };
    }

    const previewHtml = `<div class="cr101-admin-preview" style="background:#f3f4f6;padding:16px;overflow:auto;">${html}</div>`;

    return {
      ok: true,
      errors: [],
      html,
      previewHtml,
      filename: filenameFor(outputMode, templateKey),
      label: labelFor(outputMode, templateKey),
      outputMode,
      templateKey,
      ctaUrl
    };
  }

  function generateFromModel(model, options = {}) {
    const outputMode = normalizeOutputMode(options.outputMode || model?.outputMode);
    const templateKey = normalizeTemplate(options.templateKey || options.template);
    let working = model;
    if (model && options.pricingRows && shared()) {
      working = {
        ...model,
        outputMode,
        pricingModules: shared().buildPricingModules(options.pricingRows, model.nights, {
          outputMode
        })
      };
    } else if (model) {
      working = { ...model, outputMode };
    }
    return renderFragment(working, { ...options, outputMode, templateKey });
  }

  /**
   * Compose a multi-cruise newsletter issue fragment.
   * cruisePayloads: [{ model, pricingRows?, publicationStatus?, publicSlug?, name? }]
   */
  function composeIssueHtml(cruisePayloads, options = {}) {
    const soft = Boolean(options.softValidation);
    const outputMode = normalizeOutputMode(options.outputMode);
    const templateKey = normalizeTemplate(options.templateKey || options.template);
    const list = Array.isArray(cruisePayloads) ? cruisePayloads : [];
    const fragments = [];
    const errors = [];
    const warnings = [];

    if (!list.length) {
      return {
        ok: false,
        errors: ["Add at least one cruise to this newsletter before exporting."],
        warnings: [],
        html: "",
        previewHtml: "",
        filename: issueFilename(options.newsletterNumber, outputMode, templateKey),
        label: labelFor(outputMode, templateKey),
        outputMode,
        templateKey
      };
    }

    for (const payload of list) {
      const name = payload.name || payload.model?.headline || "Cruise";
      const result = generateFromModel(payload.model, {
        ...options,
        outputMode,
        templateKey,
        pricingRows: payload.pricingRows,
        publicationStatus: payload.publicationStatus,
        publicSlug: payload.publicSlug || payload.model?.publicSlug,
        softValidation: soft
      });
      if (!result.ok) {
        const detail = (result.errors || ["Could not render"]).join("; ");
        const message = `${name}: ${detail}`;
        if (soft) {
          warnings.push(message);
          continue;
        }
        errors.push(message);
      } else {
        fragments.push(result.html);
      }
    }

    if (!soft && errors.length) {
      return {
        ok: false,
        errors,
        warnings,
        html: "",
        previewHtml: "",
        filename: issueFilename(options.newsletterNumber, outputMode, templateKey),
        label: labelFor(outputMode, templateKey),
        outputMode,
        templateKey
      };
    }

    if (!fragments.length) {
      return {
        ok: false,
        errors: soft
          ? warnings.length
            ? warnings
            : ["No cruises could be previewed yet."]
          : ["No cruises could be exported."],
        warnings,
        html: "",
        previewHtml: "",
        filename: issueFilename(options.newsletterNumber, outputMode, templateKey),
        label: labelFor(outputMode, templateKey),
        outputMode,
        templateKey
      };
    }

    const spacer = `
<table role="presentation" class="cr101-issue-spacer" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
  <tr>
    <td height="48" style="height:48px;line-height:48px;font-size:0;mso-line-height-rule:exactly;">&nbsp;</td>
  </tr>
</table>`.trim();

    const html = fragments.join(`\n${spacer}\n`);
    const safety = assertFragmentSafe(html, outputMode);
    if (safety.length && !soft) {
      return {
        ok: false,
        errors: safety,
        warnings,
        html: "",
        previewHtml: "",
        filename: issueFilename(options.newsletterNumber, outputMode, templateKey),
        label: labelFor(outputMode, templateKey),
        outputMode,
        templateKey
      };
    }

    return {
      ok: true,
      errors: [],
      warnings,
      html,
      previewHtml: `<div class="cr101-admin-preview" style="background:#f3f4f6;padding:16px;overflow:auto;">${html}</div>`,
      filename: issueFilename(options.newsletterNumber, outputMode, templateKey),
      label: `${labelFor(outputMode, templateKey)} · ${fragments.length} cruise${fragments.length === 1 ? "" : "s"}`,
      outputMode,
      templateKey,
      cruiseCount: fragments.length
    };
  }

  function issueFilename(newsletterNumber, outputMode, templateKey) {
    const audience = outputMode === "airline_staff" ? "airline" : "general";
    const template = normalizeTemplate(templateKey);
    const num =
      newsletterNumber != null && String(newsletterNumber).trim() !== ""
        ? `newsletter-${String(newsletterNumber).trim()}`
        : "newsletter";
    return `101cruise-${num}-${audience}-${template}.html`;
  }

  const api = {
    SITE_ORIGIN,
    MAX_WIDTH,
    BRAND_GREEN,
    TEMPLATES,
    TEMPLATE_LABELS,
    FILENAMES,
    LABELS,
    escapeHtml,
    slugifyPublicSlug,
    isPublicImageUrl,
    isAbsoluteHttpUrl,
    isAbsoluteHttpsUrl,
    toAbsolutePublicUrl,
    buildExploreMoreUrl,
    normalizeOutputMode,
    normalizeTemplate,
    filenameFor,
    labelFor,
    issueFilename,
    validate,
    assertFragmentSafe,
    renderFragment,
    generateFromModel,
    greenHeaderMode,
    composeIssueHtml
  };

  global.NewsletterMailchimpExport = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
