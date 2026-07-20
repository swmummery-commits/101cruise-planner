/**
 * Shared Featured Cruise content helpers for newsletter + public cruise pages.
 * Pricing display rules, inclusions, and money formatting live here so both
 * renderers stay in sync without duplicating business logic.
 */
(function (global) {
  "use strict";

  const OUTPUT_MODE = {
    GENERAL: "general",
    AIRLINE_STAFF: "airline_staff"
  };

  const INCLUSION_LABELS = [
    { key: "alcohol_package", label: "Alcohol Package", shortLabel: "ALCOHOL PACKAGE" },
    { key: "wifi", label: "Wi-Fi", shortLabel: "ALL WIFI" },
    { key: "gratuities", label: "Gratuities", shortLabel: "GRATUITIES" },
    { key: "all_tours", label: "All Tours", shortLabel: "ALL TOURS" },
    { key: "all_dining", label: "All Dining", shortLabel: "ALL DINING" },
    { key: "laundry", label: "Laundry", shortLabel: "LAUNDRY" }
  ];

  function formatMoney(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return "";
    return new Intl.NumberFormat("en-AU", { maximumFractionDigits: 0 }).format(Math.round(num));
  }

  function parsePrice(value) {
    if (value === "" || value == null) return null;
    const num = Number(value);
    return Number.isFinite(num) && num >= 0 ? num : null;
  }

  /**
   * Newsletter / public pricing display metrics.
   * - Percentage off only when > 75%
   * - GREAT DEAL when discount >= 85%
   * - Hide price per day when > USD $150
   */
  function buildDiscountDisplay(brochure, discounted, nights) {
    const result = {
      perDay: null,
      showPerDay: false,
      saveAmount: null,
      percentOff: null,
      showPercentOff: false,
      greatDeal: false
    };
    if (discounted == null || !Number.isFinite(discounted) || discounted < 0) return result;

    const nightsNum = nights == null || nights === "" ? null : Number(nights);
    if (nightsNum != null && Number.isFinite(nightsNum) && nightsNum >= 1) {
      result.perDay = discounted / nightsNum;
      result.showPerDay = result.perDay <= 150;
    }

    if (brochure != null && Number.isFinite(brochure) && brochure > discounted) {
      result.saveAmount = brochure - discounted;
      const pct = Math.round((result.saveAmount / brochure) * 100);
      if (pct > 75) {
        result.percentOff = pct;
        result.showPercentOff = true;
      }
      if (pct >= 85) result.greatDeal = true;
    }
    return result;
  }

  function sortPricingRows(rows) {
    return [...(rows || [])].sort((a, b) => {
      const ao = Number(a.display_order);
      const bo = Number(b.display_order);
      const aOrder = Number.isFinite(ao) ? ao : 999;
      const bOrder = Number.isFinite(bo) ? bo : 999;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return String(a.room_label || "").localeCompare(String(b.room_label || ""), "en");
    });
  }

  /**
   * Build public-safe pricing modules.
   * Category codes are never included.
   * Airline price only when outputMode === airline_staff.
   */
  function buildPricingModules(rows, nights, options = {}) {
    const includeAirline = options.outputMode === OUTPUT_MODE.AIRLINE_STAFF;
    const sorted = sortPricingRows(rows);
    const modules = [];

    for (const row of sorted) {
      const roomLabel = String(row.room_label || "").trim();
      if (!roomLabel) continue;

      const brochure = parsePrice(row.brochure_price);
      const cruise101 = parsePrice(row.cruise_101_price);
      const airline = includeAirline ? parsePrice(row.airline_price) : null;

      if (cruise101 == null && airline == null && brochure == null) continue;
      if (!includeAirline && cruise101 == null && brochure == null) continue;
      if (includeAirline && airline == null && cruise101 == null && brochure == null) continue;

      modules.push({
        roomLabel,
        brochurePrice: brochure,
        cruise101Price: cruise101,
        airlinePrice: airline,
        cruise101Display: cruise101 != null ? buildDiscountDisplay(brochure, cruise101, nights) : null,
        airlineDisplay: airline != null ? buildDiscountDisplay(brochure, airline, nights) : null
      });
    }
    return modules;
  }

  function buildInclusionItems(source = {}) {
    const items = [];
    for (const entry of INCLUSION_LABELS) {
      if (source[entry.key]) {
        items.push({
          key: entry.key,
          label: entry.label,
          shortLabel: entry.shortLabel || String(entry.label || "").toUpperCase()
        });
      }
    }
    const obc = parsePrice(source.onboard_credit);
    if (obc != null && obc > 0) {
      items.push({
        key: "onboard_credit",
        label: `On Board Credit $${formatMoney(obc)}`,
        shortLabel: `ON BOARD CREDIT $${formatMoney(obc)}`
      });
    }
    return items;
  }

  /** Strip confidential fields before any public payload leaves the server. */
  function sanitizePricingForPublic(rows) {
    return sortPricingRows(rows).map((row) => ({
      room_label: row.room_label || "",
      brochure_price: row.brochure_price == null ? null : Number(row.brochure_price),
      cruise_101_price: row.cruise_101_price == null ? null : Number(row.cruise_101_price),
      display_order: Number(row.display_order) || 0
      // airline_price intentionally omitted
      // category intentionally omitted
    }));
  }

  function sanitizeCruiseForPublic(cruise, pricingRows) {
    if (!cruise) return null;
    return {
      headline: cruise.headline || "",
      destination_strip: cruise.destination_strip || "",
      departure_port: cruise.departure_port || "",
      arrival_port: cruise.arrival_port || "",
      departure_date: cruise.departure_date || "",
      return_date: cruise.return_date || "",
      nights: cruise.nights == null ? null : Number(cruise.nights),
      cruise_line_name: cruise.cruise_line_name || cruise.ci_cruise_lines?.name || "",
      ship_name: cruise.ship_name || cruise.ci_cruise_ships?.name || "",
      hero: cruise.hero || null,
      hero_image_url: cruise.hero?.url || cruise.hero_image_url || "",
      hero_image_alt: cruise.hero?.alt_text || cruise.hero_image_alt || "",
      short_editorial: cruise.short_editorial || "",
      full_description: cruise.full_description || "",
      itinerary_summary: cruise.itinerary_summary || "",
      route_map: cruise.route_map || null,
      route_map_image_url: cruise.route_map?.url || cruise.route_map_image_url || "",
      alcohol_package: Boolean(cruise.alcohol_package),
      wifi: Boolean(cruise.wifi),
      gratuities: Boolean(cruise.gratuities),
      all_tours: Boolean(cruise.all_tours),
      all_dining: Boolean(cruise.all_dining),
      laundry: Boolean(cruise.laundry),
      onboard_credit: cruise.onboard_credit == null ? null : Number(cruise.onboard_credit),
      other_information: cruise.other_information || "",
      public_slug: cruise.public_slug || ""
      // Room pricing omitted from public cruise pages.
    };
  }

  function buildEnquiryMailto(cruise) {
    const email = "paul@101cruise.com.au";
    const headline = String(cruise?.headline || "Cruise enquiry").trim();
    const subject = `Cruise enquiry – ${headline}`;
    const body = [
      "Hi Paul,",
      "",
      "I would like to enquire about this cruise:",
      "",
      `Cruise: ${headline}`,
      `Cruise line: ${cruise?.cruise_line_name || "—"}`,
      `Ship: ${cruise?.ship_name || "—"}`,
      `Departure: ${cruise?.departure_date || "—"}`,
      `Page: /cruise/${cruise?.public_slug || ""}`,
      "",
      "Thank you."
    ].join("\n");
    return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  global.NewsletterCruiseShared = {
    OUTPUT_MODE,
    INCLUSION_LABELS,
    formatMoney,
    parsePrice,
    buildDiscountDisplay,
    sortPricingRows,
    buildPricingModules,
    buildInclusionItems,
    sanitizePricingForPublic,
    sanitizeCruiseForPublic,
    buildEnquiryMailto
  };
})(typeof window !== "undefined" ? window : globalThis);
