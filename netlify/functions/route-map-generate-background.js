/**
 * Route map generation worker — Netlify Background Function.
 *
 * The synchronous route-map-generate endpoint remains available for status,
 * preview and delete. Heavy first-time marine routing is dispatched here so
 * the browser request is not constrained by the normal synchronous function
 * timeout.
 */

const routeMap = require("./route-map-generate");

exports.handler = async (event, context) => {
  // Reuse the exact same authenticated generation workflow. Netlify recognises
  // the -background suffix and lets this continue after returning HTTP 202 to
  // the caller.
  return routeMap.handler(event, context);
};
