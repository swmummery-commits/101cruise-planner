#!/usr/bin/env node
/**
 * Shared cruise-discovery-ops insert projection tests for itinerary_ports.
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const ops = require(path.join(root, "netlify/functions/lib/cruise-discovery-ops"));

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  passed += 1;
}

const merged = { departure_port: "Port", departure_port_meta: null, blocked: false, reason: "new" };
const now = new Date().toISOString();
const base = {
  cruise_line_id: "l",
  ship_id: "s",
  destination_id: "d",
  departure_date: "2028-06-01",
  return_date: "2028-06-08",
  nights: 7,
  departure_port: "Port",
  itinerary: "Port",
  official_url: "https://example.com",
  external_key: "ext",
  official_sailing_id: "ID1",
  raw_extract: {}
};

const insert = ops.buildDiscoveredCruiseUpsertPayload(
  { ...base, itinerary_ports: ["San Cristobal", "Baltra"] },
  merged,
  { identity_key: "k", status: "active", reasons: [], now, includeItineraryPorts: true }
);
assert(Array.isArray(insert.itinerary_ports), "insert has ports");
assert(insert.itinerary_ports[0] === "San Cristobal", "first port");
assert(ops.normalizeItineraryPortsForDb({ itinerary_ports: null }).length === 0, "null -> []");

const update = ops.buildDiscoveredCruiseUpsertPayload(
  { ...base, itinerary_ports: ["A"] },
  merged,
  { identity_key: "k", status: "active", reasons: [], now, includeItineraryPorts: false }
);
assert(!Object.prototype.hasOwnProperty.call(update, "itinerary_ports"), "update omits ports");

console.log(`cruise-discovery-ops itinerary_ports tests passed (${passed})`);
