/**
 * Usage insights admin filter — exclude site admins from customer metrics by default.
 *
 * Run: node scripts/test-usage-insights-admin-filter.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { parseAdminsFilter, filterAdminEvents, buildInsights } = require(
  path.join(root, "netlify/functions/usage-insights.js")
);

assert.equal(parseAdminsFilter({}), "exclude");
assert.equal(parseAdminsFilter({ admins: "exclude" }), "exclude");
assert.equal(parseAdminsFilter({ admins: "include" }), "include");
assert.equal(parseAdminsFilter({ admins: "INCLUDE" }), "include");
assert.equal(parseAdminsFilter({ admins: "unknown" }), "exclude");

const adminId = "11111111-1111-1111-1111-111111111111";
const customerId = "22222222-2222-2222-2222-222222222222";
const adminIds = new Set([adminId]);

const events = [
  {
    user_id: adminId,
    booking_reference: "ADM001",
    session_id: "s1",
    surface: "my_cruise",
    module: "dashboard",
    event_type: "page_open",
    occurred_at: "2026-08-01T10:00:00.000Z",
    metadata: { customer_label: "Admin User" }
  },
  {
    user_id: customerId,
    booking_reference: "CUS001",
    session_id: "s2",
    surface: "my_cruise",
    module: "packing",
    event_type: "page_open",
    occurred_at: "2026-08-01T11:00:00.000Z",
    metadata: { customer_label: "Real Customer" }
  },
  {
    user_id: null,
    booking_reference: null,
    session_id: "s3",
    surface: "public_tools",
    module: "public_drinks_calculator",
    event_type: "page_open",
    occurred_at: "2026-08-01T12:00:00.000Z",
    metadata: {}
  }
];

const excluded = filterAdminEvents(events, adminIds, "exclude");
assert.equal(excluded.length, 2, "admin my_cruise event removed; public kept");
assert.ok(excluded.every(e => e.user_id !== adminId));

const included = filterAdminEvents(events, adminIds, "include");
assert.equal(included.length, 3, "include mode keeps all events");

const rangeInfo = {
  start: new Date("2026-08-01T00:00:00.000Z"),
  end: new Date("2026-08-05T23:59:59.999Z"),
  range: "7d"
};

const excludedInsights = buildInsights(excluded, rangeInfo);
assert.equal(excludedInsights.summary.active_customers, 1);
assert.equal(excludedInsights.customers.length, 1);
assert.equal(excludedInsights.customers[0].customer, "Real Customer");

const includedInsights = buildInsights(included, rangeInfo);
assert.equal(includedInsights.summary.active_customers, 2);
assert.equal(includedInsights.customers.length, 2);

console.log("test-usage-insights-admin-filter: all assertions passed");
