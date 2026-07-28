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

/**
 * First row (by display_order) with a valid cruise_101_price.
 * Does not choose the numerically lowest price.
 */
function selectPublicOffer(rows, nights) {
  const safe = sanitizePublicPricingRows(rows);
  for (const row of safe) {
    if (!row.room_label) continue;
    if (row.cruise_101_price == null) continue;
    const discount = buildDiscountDisplay(row.brochure_price, row.cruise_101_price, nights);
    return {
      roomLabel: row.room_label,
      brochurePrice: row.brochure_price,
      cruise101Price: row.cruise_101_price,
      displayOrder: row.display_order,
      discount,
      priceLabel: `FROM US$${formatMoney(row.cruise_101_price)} PP`,
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
  return null;
}

const PUBLIC_PRICING_SELECT =
  "featured_cruise_id,room_label,brochure_price,cruise_101_price,display_order";

module.exports = {
  parsePrice,
  formatMoney,
  sortPricingRows,
  sanitizePublicPricingRows,
  buildDiscountDisplay,
  selectPublicOffer,
  PUBLIC_PRICING_SELECT
};
