/**
 * Social Pack template selection — classic (default) and premium_dark.
 */

const TEMPLATES = {
  classic: "classic",
  premium_dark: "premium_dark"
};

const TEMPLATE_LABELS = {
  classic: "Classic",
  premium_dark: "Premium Dark"
};

function normaliseTemplate(value) {
  const key = String(value || "classic")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  return key === TEMPLATES.premium_dark ? TEMPLATES.premium_dark : TEMPLATES.classic;
}

module.exports = {
  TEMPLATES,
  TEMPLATE_LABELS,
  normaliseTemplate
};
