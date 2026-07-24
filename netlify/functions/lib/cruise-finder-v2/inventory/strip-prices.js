/**
 * Strip all provider price / fare fields before canonicalisation.
 */

const { FORBIDDEN_PRICE_FIELDS } = require("./canonical-inventory");

/**
 * Deep-clone JSON-safe values and remove forbidden price keys at every object level.
 * @param {any} value
 * @returns {{ cleaned: any, removedFields: string[] }}
 */
function stripProviderPrices(value) {
  const removed = new Set();

  function walk(node) {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out = {};
    for (const [key, val] of Object.entries(node)) {
      if (FORBIDDEN_PRICE_FIELDS.includes(key)) {
        removed.add(key);
        continue;
      }
      // Nested price-shaped keys
      if (/^price/i.test(key) || /fare/i.test(key) || key === "currency") {
        removed.add(key);
        continue;
      }
      out[key] = walk(val);
    }
    return out;
  }

  return { cleaned: walk(value), removedFields: [...removed].sort() };
}

/**
 * Assert a canonical sailing (or any object) has no forbidden price fields.
 * @param {any} obj
 * @returns {{ ok: boolean, violations: string[] }}
 */
function assertNoPrices(obj) {
  const violations = [];
  const json = JSON.stringify(obj);
  for (const field of FORBIDDEN_PRICE_FIELDS) {
    // Match JSON keys only: "price":
    const re = new RegExp(`"${field}"\\s*:`);
    if (re.test(json)) violations.push(field);
  }
  // Broad currency key check
  if (/"currency"\s*:/.test(json)) violations.push("currency");
  return { ok: violations.length === 0, violations: [...new Set(violations)] };
}

module.exports = {
  stripProviderPrices,
  assertNoPrices
};
