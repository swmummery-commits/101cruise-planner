/**
 * Royal Caribbean International — destination mapping.
 * Reuses Celebrity RCG destination-code semantics where they match.
 * Adds RC-only codes (MEXCO, SOPAC). Does not create production destinations.
 */

const { resolveCelebrityDestinationHints } = require("./celebrity-destination-mapping");

const ROYAL_CARIBBEAN_DESTINATION_CODE_SLUG = Object.freeze({
  MEXCO: "mexican-riviera",
  SOPAC: "south-pacific"
});

function resolveRoyalCaribbeanDestinationHints(raw) {
  const code = String(raw?.destination_code || "").toUpperCase();
  const rcDirect = ROYAL_CARIBBEAN_DESTINATION_CODE_SLUG[code];
  if (rcDirect) {
    return { slug: rcDirect, method: `royal_caribbean_destination_code_${code}` };
  }

  const celebrity = resolveCelebrityDestinationHints(raw);
  if (celebrity) {
    return {
      ...celebrity,
      method: String(celebrity.method || "").replace(/^celebrity_/, "royal_caribbean_")
    };
  }
  return null;
}

module.exports = {
  ROYAL_CARIBBEAN_DESTINATION_CODE_SLUG,
  resolveRoyalCaribbeanDestinationHints
};
