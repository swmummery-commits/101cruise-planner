import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const { nearestCoastalWater } = require("../netlify/functions/lib/route-map-coastal-location");
assert.equal(nearestCoastalWater(10, 20, () => true), null);
const water = nearestCoastalWater(10, 20, (lon) => lon <= 20.01);
assert.ok(water.longitude > 20.01 && water.longitude < 20.02);

const { resolvePort } = require("../netlify/functions/geocode-ports");
const originalFetch = globalThis.fetch;
try {
  const hit = (type) => ({
    lat: "-32.05", lon: "115.74", display_name: "Fremantle, Western Australia, Australia",
    type, category: type === "town" ? "place" : "harbour",
    address: { country: "Australia", country_code: "au" }
  });
  const port = { city: "Fremantle", canonical_name: "Fremantle", country: "Australia" };
  globalThis.fetch = async () => new Response(JSON.stringify([hit("town"), hit("pier")]));
  assert.equal((await resolvePort(port, { classifyLocation: true })).location_kind, "port");
  globalThis.fetch = async () => new Response(JSON.stringify([hit("town")]));
  assert.equal((await resolvePort(port, { classifyLocation: true })).location_kind, "town");
  globalThis.fetch = async () => new Response(JSON.stringify([hit("building")]));
  assert.equal((await resolvePort(port, { classifyLocation: true })).ok, false);
} finally {
  globalThis.fetch = originalFetch;
}

const workerSource = readFileSync(new URL("../netlify/functions/newsletter-route-map-worker-background.js", import.meta.url), "utf8");
const job = { cruise_id: "cruise", newsletter_id: "issue", claim_token: "token", fingerprint: "input" };

async function runWorker({ statusCode = 200, result = {}, linked = true, authorized = true } = {}) {
  const requests = [];
  const exports = {};
  runInNewContext(workerSource, {
    exports, console: { info() {}, error() {}, warn() {} },
    require(module) {
      if (module === "./route-map-generate") return {
        async generateRouteMap(id, options) {
          requests.push(["generate", id, options.allow_approximate_locations]);
          return { statusCode, body: JSON.stringify(result) };
        }
      };
      return {
        authorizedWorker: () => authorized,
        async dispatchWorker() { requests.push(["dispatch"]); },
        async rest(path, { body } = {}) {
          requests.push([path, body]);
          if (path === "rpc/claim_newsletter_route_map") return [job];
          if (path.startsWith("featured_cruises?")) return linked ? [{ id: "cruise" }] : [];
        }
      };
    }
  });
  const { statusCode: httpStatus } = await exports.handler({ httpMethod: "POST", headers: {} });
  return { requests, httpStatus };
}
const rejected = await runWorker({ authorized: false });
assert.equal(rejected.httpStatus, 401);
assert.equal(rejected.requests.length, 0);
const ready = await runWorker({ result: { ok: true, warnings: [{ code: "approximate_location" }] } });
const finish = (run) => run.requests.find(([name]) => name === "rpc/finish_newsletter_route_map")[1];
assert.equal(finish(ready).outcome, "ready");
assert.match(finish(ready).outcome_message, /approximate/);
assert.deepEqual(ready.requests.at(-1), ["dispatch"]);
const blocked = await runWorker({ statusCode: 400, result: { errors: [{ code: "missing_coordinates", message: "Check this port." }] } });
assert.equal(finish(blocked).outcome, "needs_attention");
assert.equal(finish(blocked).outcome_message, "Check this port.");
assert.deepEqual(blocked.requests.at(-1), ["dispatch"]);
const moved = await runWorker({ linked: false });
assert.equal(moved.requests.some(([name]) => name === "generate"), false);

console.log("Newsletter map worker and coastal fallback tests passed");
