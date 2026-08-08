/**
 * Explicit customer-facing compound port labels → canonical physical port.
 * Used when slash/paren heuristics would pick the wrong physical port.
 *
 * Source of truth is mirrored in destination-content.js `port_canonical_names`.
 */

const { normaliseEntityKey } = require("./research-normalize");

/** @type {Record<string, { canonical_name: string, country?: string }>} */
const COMPOUND_PORT_LABELS = {
  [normaliseEntityKey("Tokyo / Yokohama")]: {
    canonical_name: "Yokohama",
    country: "Japan"
  }
};

function lookupCompoundPortLabel(portName) {
  const key = normaliseEntityKey(portName);
  return key ? COMPOUND_PORT_LABELS[key] || null : null;
}

module.exports = {
  COMPOUND_PORT_LABELS,
  lookupCompoundPortLabel
};
