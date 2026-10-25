/**
 * Social Pack template selection.
 * Classic and Premium Dark stay the existing carousel packs.
 * Promotional templates are additional choices.
 */

const TEMPLATES = {
  classic: "classic",
  premium_dark: "premium_dark",
  route_deal: "route_deal",
  price_shock: "price_shock",
  destination_journey: "destination_journey",
  ship_journey: "ship_journey"
};

const TEMPLATE_LABELS = {
  classic: "Classic",
  premium_dark: "Premium Dark",
  route_deal: "Route Deal",
  price_shock: "Price Shock",
  destination_journey: "Destination Journey",
  ship_journey: "Ship + Journey"
};

const PROMO_TEMPLATES = new Set([
  TEMPLATES.route_deal,
  TEMPLATES.price_shock,
  TEMPLATES.destination_journey,
  TEMPLATES.ship_journey
]);

const MAP_TEMPLATES = new Set([TEMPLATES.route_deal, TEMPLATES.ship_journey]);

const ALIASES = {
  premiumdark: TEMPLATES.premium_dark,
  route_deal: TEMPLATES.route_deal,
  routedeal: TEMPLATES.route_deal,
  price_shock: TEMPLATES.price_shock,
  priceshock: TEMPLATES.price_shock,
  destination_journey: TEMPLATES.destination_journey,
  destinationjourney: TEMPLATES.destination_journey,
  ship_journey: TEMPLATES.ship_journey,
  ship_and_journey: TEMPLATES.ship_journey,
  shipjourney: TEMPLATES.ship_journey
};

function normaliseTemplate(value) {
  const key = String(value || "classic")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (key === TEMPLATES.premium_dark) return TEMPLATES.premium_dark;
  if (ALIASES[key]) return ALIASES[key];
  if (TEMPLATES[key]) return TEMPLATES[key];
  return TEMPLATES.classic;
}

function isPromoTemplate(value) {
  return PROMO_TEMPLATES.has(normaliseTemplate(value));
}

function templateHasMap(value) {
  return MAP_TEMPLATES.has(normaliseTemplate(value));
}

function templateShowsSavings(value) {
  return isPromoTemplate(value);
}

function templateSlug(value) {
  return normaliseTemplate(value).replace(/_/g, "-");
}

module.exports = {
  TEMPLATES,
  TEMPLATE_LABELS,
  normaliseTemplate,
  isPromoTemplate,
  templateHasMap,
  templateShowsSavings,
  templateSlug
};
