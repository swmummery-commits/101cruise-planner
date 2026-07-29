/**
 * Public-safe pricing selection for Social Pack.
 * Never accepts or returns airline_price or category.
 */

function parsePrice(value) {
  if (value === "" || value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function formatMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "";
  return new Intl.NumberFormat("en-AU", { maximumFractionDigits: 0 }).format(Math.round(num));
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

/** Strip confidential fields — airline_price and category never leave this helper. */
function sanitizePublicPricingRows(rows) {
  return sortPricingRows(rows).map((row) => ({
    room_label: String(row.room_label || "").trim(),
    brochure_price: parsePrice(row.brochure_price),
    cruise_101_price: parsePrice(row.cruise_101_price),
    display_order: Number.isFinite(Number(row.display_order)) ? Number(row.display_order) : 999
  }));
}

/**
 * Customer-facing room label for social slides.
 * Does not invent new cabin types — only light normalisation.
 */
function normaliseRoomLabel(raw) {
  let label = String(raw || "").trim();
  if (!label) return "";
  label = label.replace(/\s+/g, " ");
  label = label.replace(/\bsingles?\b/gi, "Solo");
  label = label.replace(/\s*[-–—]\s*/g, " ");
  label = label.replace(/\s+/g, " ").trim();
  return label.toUpperCase();
}

function roomSlug(raw) {
  return (
    String(normaliseRoomLabel(raw) || "room")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "room"
  );
}

function buildDiscountDisplay(brochure, discounted, nights) {
  const result = {
    saveAmount: null,
    percentOff: null,
    showPercentOff: false,
    greatDeal: false,
    perDay: null,
    showPerDay: false
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

function offerFromRow(row, nights) {
  const discount = buildDiscountDisplay(row.brochure_price, row.cruise_101_price, nights);
  const displayLabel = normaliseRoomLabel(row.room_label);
  return {
    roomLabel: row.room_label,
    roomLabelDisplay: displayLabel,
    roomSlug: roomSlug(row.room_label),
    brochurePrice: row.brochure_price,
    cruise101Price: row.cruise_101_price,
    displayOrder: row.display_order,
    discount,
    brochureLabel: row.brochure_price != null ? `US$${formatMoney(row.brochure_price)}` : null,
    priceLabel: `US$${formatMoney(row.cruise_101_price)}`,
    priceLabelFrom: `FROM US$${formatMoney(row.cruise_101_price)} PP`,
    saveLabel:
      discount.saveAmount != null ? `SAVE US$${formatMoney(discount.saveAmount)}` : null,
    percentLabel: discount.showPercentOff ? `${discount.percentOff}% OFF` : null,
    greatDeal: discount.greatDeal,
    perDayLabel:
      discount.showPerDay && discount.perDay != null
        ? `US$${formatMoney(discount.perDay)} per day`
        : null
  };
}

/**
 * First row (by display_order) with a valid cruise_101_price.
 * Does not choose the numerically lowest price.
 */
function selectPublicOffer(rows, nights) {
  const offers = selectPublicOffers(rows, nights, 1);
  return offers[0] || null;
}

/**
 * Up to `limit` public offers by display_order with valid cruise_101_price.
 */
function selectPublicOffers(rows, nights, limit = 3) {
  const max = Math.max(0, Math.min(3, Math.trunc(Number(limit) || 3)));
  const safe = sanitizePublicPricingRows(rows);
  const out = [];
  for (const row of safe) {
    if (out.length >= max) break;
    if (!row.room_label) continue;
    if (row.cruise_101_price == null) continue;
    out.push(offerFromRow(row, nights));
  }
  return out;
}

const PUBLIC_PRICING_SELECT =
  "featured_cruise_id,room_label,brochure_price,cruise_101_price,display_order";

module.exports = {
  parsePrice,
  formatMoney,
  sortPricingRows,
  sanitizePublicPricingRows,
  normaliseRoomLabel,
  roomSlug,
  buildDiscountDisplay,
  selectPublicOffer,
  selectPublicOffers,
  PUBLIC_PRICING_SELECT
};
