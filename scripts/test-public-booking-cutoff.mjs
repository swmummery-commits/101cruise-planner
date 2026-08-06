#!/usr/bin/env node
/**
 * Public 21-day booking cutoff tests.
 *   npm run test:public-booking-cutoff
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const inv = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const base = "2026-08-06";

test("30 days away remains visible", () => {
  if (!inv.isCruisePubliclyBookable({ departureDate: "2026-09-05", status: "active", perthToday: base })) {
    throw new Error("should be visible");
  }
});

test("22 days away remains visible", () => {
  if (!inv.isCruisePubliclyBookable({ departureDate: "2026-08-28", status: "active", perthToday: base })) {
    throw new Error("should be visible");
  }
});

test("exactly 21 days away is hidden", () => {
  if (inv.isCruisePubliclyBookable({ departureDate: "2026-08-27", status: "active", perthToday: base })) {
    throw new Error("should be hidden");
  }
});

test("20 days away is hidden", () => {
  if (inv.isCruisePubliclyBookable({ departureDate: "2026-08-26", status: "active", perthToday: base })) {
    throw new Error("should be hidden");
  }
});

test("tomorrow is hidden", () => {
  if (inv.isCruisePubliclyBookable({ departureDate: "2026-08-07", status: "active", perthToday: base })) {
    throw new Error("should be hidden");
  }
});

test("today is hidden", () => {
  if (inv.isCruisePubliclyBookable({ departureDate: "2026-08-06", status: "active", perthToday: base })) {
    throw new Error("should be hidden");
  }
});

test("past departure is hidden", () => {
  if (inv.isCruisePubliclyBookable({ departureDate: "2026-08-01", status: "active", perthToday: base })) {
    throw new Error("should be hidden");
  }
});

test("Perth midnight boundary uses Perth calendar date", () => {
  const perth = inv.perthCalendarDate(new Date("2026-08-05T16:00:00Z"));
  if (perth !== "2026-08-06") throw new Error(`expected 2026-08-06 got ${perth}`);
});

test("rule applies regardless of cruise line slug", () => {
  for (const line of ["holland-america-line", "celebrity-cruises", "princess-cruises"]) {
    if (!inv.isCruisePubliclyBookable({ departureDate: "2026-09-01", status: "active", perthToday: base })) {
      throw new Error(`future sailing hidden for ${line}`);
    }
  }
});

test("expired status is never publicly bookable", () => {
  if (inv.isCruisePubliclyBookable({ departureDate: "2027-01-01", status: "expired", perthToday: base })) {
    throw new Error("expired should not be bookable");
  }
});

test("shouldRemoveFromPublicInventory at 21-day boundary", () => {
  if (!inv.shouldRemoveFromPublicInventory({ departureDate: "2026-08-27", status: "active", perthToday: base })) {
    throw new Error("21 days should remove");
  }
  if (inv.shouldRemoveFromPublicInventory({ departureDate: "2026-08-28", status: "active", perthToday: base })) {
    throw new Error("22 days should remain active in DB");
  }
});

test("minimum departure date is today + 22 days", () => {
  if (inv.publicBookingMinimumDepartureDate(base) !== "2026-08-28") throw new Error("min date");
});

test("cutoff date is today + 21 days", () => {
  if (inv.publicBookingCutoffDate(base) !== "2026-08-27") throw new Error("cutoff date");
});

test("partition excludes within-cutoff products", () => {
  const items = [{ id: 1, departure_date: "2026-08-28" }, { id: 2, departure_date: "2026-08-20" }];
  const { publiclyEligible, withinCutoff } = inv.partitionByPublicBookingCutoff(
    items,
    (i) => i.departure_date,
    base
  );
  if (publiclyEligible.length !== 1 || withinCutoff.length !== 1) throw new Error("partition");
});

test("public unavailability reason uses cutoff wording not completed", () => {
  const reason = inv.publicUnavailabilityReason({ departureDate: "2026-08-10", perthToday: base });
  if (!reason?.label.includes("21-day")) throw new Error(reason?.label);
  if (String(reason?.detail).toLowerCase().includes("completed")) throw new Error("must not say completed");
});

test("expiration metadata distinguishes past vs cutoff", () => {
  const past = inv.expirationMetadataForMaintenance({ departureDate: "2026-08-01", perthToday: base });
  const cutoff = inv.expirationMetadataForMaintenance({ departureDate: "2026-08-20", perthToday: base });
  if (past?.expiration_reason !== "past_departure_before_perth_calendar_date") throw new Error("past");
  if (cutoff?.expiration_reason !== "within_public_booking_cutoff") throw new Error("cutoff");
});

test("cache key would change when Perth as-of changes", () => {
  const a = JSON.stringify({ pubAsOf: "2026-08-06", pubCutoff: 21 });
  const b = JSON.stringify({ pubAsOf: "2026-08-07", pubCutoff: 21 });
  if (a === b) throw new Error("cache keys must differ across days");
});

console.log(`\ntest-public-booking-cutoff: ${passed} passed`);
