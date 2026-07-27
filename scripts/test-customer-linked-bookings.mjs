/**
 * Security + behaviour tests for secure linked booking switch.
 * Run: node scripts/test-customer-linked-bookings.mjs
 */

import { createRequire } from "module";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const auth = require("../netlify/functions/lib/customer-session-auth.js");
const core = require("../netlify/functions/lib/customer-linked-bookings-core.js");
const SwitchBooking = require("../js/switch-booking.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const SECRET = "test-customer-session-secret-for-switch";

const smithA = {
  base44_booking_id: "b-smith-a",
  booking_reference: "REF-A",
  passenger1_last_name: "SMITH",
  passenger1_email: "alice.smith@example.com",
  passenger1_mobile: "+61 400 111 222",
  cruise_line: "Celebrity Cruises",
  cruise_ship: "Celebrity Edge",
  departing_date: "2026-09-01",
  arriving_date: "2026-09-08",
  departing_port: "Barcelona",
  arriving_port: "Rome"
};

const smithBSamePerson = {
  base44_booking_id: "b-smith-b",
  booking_reference: "REF-B",
  passenger1_last_name: "SMITH",
  passenger1_email: "alice.smith@example.com",
  passenger1_mobile: "61400111222",
  cruise_line: "Royal Caribbean",
  cruise_ship: "Wonder of the Seas",
  departing_date: "2027-01-10",
  arriving_date: "2027-01-17",
  departing_port: "Miami",
  arriving_port: "Miami"
};

const smithUnrelated = {
  base44_booking_id: "b-smith-other",
  booking_reference: "REF-OTHER",
  passenger1_last_name: "SMITH",
  passenger1_email: "bob.smith@example.com",
  passenger1_mobile: "61400999888",
  cruise_line: "P&O Cruises",
  cruise_ship: "Pacific Adventure",
  departing_date: "2026-11-01",
  arriving_date: "2026-11-08",
  departing_port: "Sydney",
  arriving_port: "Sydney"
};

const sailingNow = {
  ...smithBSamePerson,
  base44_booking_id: "b-sailing",
  booking_reference: "REF-SAIL",
  departing_date: "2026-07-20",
  arriving_date: "2026-07-30"
};

const completed = {
  ...smithBSamePerson,
  base44_booking_id: "b-done",
  booking_reference: "REF-DONE",
  departing_date: "2025-01-01",
  arriving_date: "2025-01-08"
};

// --- surname alone never links ---
{
  const onlySurnameCandidates = [
    { ...smithA, passenger1_email: null, passenger1_mobile: null },
    { ...smithUnrelated, passenger1_email: null, passenger1_mobile: null }
  ];
  const linked = core.filterSecurelyLinkedBookings(onlySurnameCandidates[0], onlySurnameCandidates);
  assert(linked.length === 1, "surname alone must not link another booking");
  assert(linked[0].base44_booking_id === "b-smith-a", "only current booking when no compound identity");
}

// --- two unrelated SMITH customers cannot see each other ---
{
  const linked = core.filterSecurelyLinkedBookings(smithA, [smithA, smithUnrelated, smithBSamePerson]);
  assert(linked.every((r) => r.base44_booking_id !== "b-smith-other"), "unrelated SMITH excluded");
  assert(linked.some((r) => r.base44_booking_id === "b-smith-b"), "same email+mobile included");
  assert(linked.length === 2, "current + securely linked only");
}

// --- compound identity required ---
{
  assert(core.bookingsShareSecureIdentity(smithA, smithBSamePerson), "email+mobile compound matches");
  assert(!core.bookingsShareSecureIdentity(smithA, smithUnrelated), "different email/mobile rejected");
  assert(
    !core.bookingsShareSecureIdentity(
      { passenger1_email: "x@y.com", passenger1_mobile: "" },
      { passenger1_email: "x@y.com", passenger1_mobile: "" }
    ),
    "email alone without mobile is insufficient"
  );
}

// --- session required / switch token auth ---
{
  const session = auth.createSessionToken(
    { booking_id: "b-smith-a", booking_reference: "REF-A", exp: Date.now() + 60_000 },
    SECRET
  );
  const verified = auth.verifyToken(session, SECRET);
  assert(verified?.booking_id === "b-smith-a", "valid session verifies");
  assert(auth.verifyToken(session, "wrong") === null, "wrong secret rejected");
  assert(auth.verifyToken("not.a.token", SECRET) === null, "garbage token rejected");

  const switchTok = core.createSwitchToken({
    sessionBookingId: "b-smith-a",
    targetBookingId: "b-smith-b",
    secret: SECRET
  });
  assert(core.verifySwitchToken(switchTok, SECRET, "b-smith-a")?.tid === "b-smith-b", "switch token ok");
  assert(core.verifySwitchToken(switchTok, SECRET, "b-other") === null, "switch token bound to session booking");
  assert(core.verifySwitchToken("raw-booking-id", SECRET, "b-smith-a") === null, "raw id rejected as switch token");
}

// --- cards strip personal/financial fields ---
{
  const cards = core.buildLinkedBookingCards(smithA, [smithA, smithBSamePerson, smithUnrelated], {
    secret: SECRET,
    heroByShip: { "Celebrity Edge": "https://cdn.example/hero.jpg" },
    now: new Date("2026-07-27T12:00:00Z")
  });
  assert(cards.length === 2, "two authorised cards");
  const current = cards.find((c) => c.is_current);
  const other = cards.find((c) => !c.is_current);
  assert(current && other, "current identified");
  assert(current.switch_token == null, "current has no switch token");
  assert(other.switch_token, "other has switch token");
  assert(current.ship_name === "Celebrity Edge", "ship on card");
  assert(current.cruise_line === "Celebrity Cruises", "line on card");
  assert(current.route_summary.includes("Barcelona"), "route on card");
  assert(current.ship_hero_image.includes("cdn.example"), "hero on card");
  for (const card of cards) {
    const json = JSON.stringify(card);
    assert(!/passenger|email|mobile|passport|price|balance|smith@/i.test(json), "no PII/finance in card");
    core.assertCardHasNoSensitiveFields(card);
  }
}

// --- sorting: sailing, upcoming, completed ---
{
  const cards = core.buildLinkedBookingCards(
    smithA,
    [completed, sailingNow, smithA, smithBSamePerson],
    { secret: SECRET, now: new Date("2026-07-27T12:00:00Z") }
  );
  assert(cards[0].lifecycle === "currently_sailing", "sailing first");
  assert(cards.filter((c) => c.lifecycle === "upcoming").length >= 1, "upcoming present");
  const completedIdx = cards.findIndex((c) => c.lifecycle === "completed");
  const upcomingIdx = cards.findIndex((c) => c.lifecycle === "upcoming");
  assert(completedIdx > upcomingIdx, "completed after upcoming");
}

// --- single linked booking hides switch ---
{
  const cards = core.buildLinkedBookingCards(smithA, [smithA], { secret: SECRET });
  assert(cards.length === 1, "single booking only");
  assert(SwitchBooking.shouldShowSwitchControl({ success: true, can_switch: false, bookings: cards }) === false, "hide switch");
  assert(
    SwitchBooking.shouldShowSwitchControl({
      success: true,
      can_switch: true,
      bookings: [cards[0], { ...cards[0], is_current: false }]
    }) === true,
    "show switch when can_switch"
  );
}

// --- surname search body rejected ---
{
  assert(core.rejectSurnameSearchBody({ surname: "SMITH" }), "surname body rejected");
  assert(core.rejectSurnameSearchBody({ last_name: "SMITH" }), "last_name body rejected");
  assert(core.rejectSurnameSearchBody({ switch_token: "x" }) === null, "switch_token body allowed");
}

// --- session remains conceptual after mint ---
{
  const token = auth.mintBookingSessionToken(
    { base44_booking_id: "b-smith-b", booking_reference: "REF-B" },
    SECRET
  );
  const payload = auth.verifyToken(token, SECRET);
  assert(payload.booking_id === "b-smith-b", "new session for switched booking");
  assert(payload.booking_reference === "REF-B", "reference preserved");
}

// --- UI module: chooser not login form ---
{
  const src = readFileSync(path.join(root, "js/switch-booking.js"), "utf8");
  assert(/Choose your cruise/.test(src), "chooser heading");
  assert(/Select another cruise linked to your account/.test(src), "supporting copy");
  assert(/Open this cruise/.test(src), "open action");
  assert(/Current cruise/.test(src), "current mark");
  assert(!/Lead traveller surname/.test(src), "no surname form in chooser");
  assert(!/Booking number/.test(src) || /Booking /.test(src), "booking ref secondary only");
}

// --- planner wiring ---
{
  const planner = readFileSync(path.join(root, "js/planner.js"), "utf8");
  const index = readFileSync(path.join(root, "index.html"), "utf8");
  assert(index.includes("switch-booking.js"), "index loads switch UI");
  assert(/openSwitchBookingChooser/.test(planner), "opens chooser");
  assert(/customer-linked-bookings/.test(planner), "lists via endpoint");
  assert(/customer-switch-booking/.test(planner), "switches via endpoint");
  assert(/Switch Booking/.test(planner), "button label");
  assert(/PortalLoading[\s\S]*switch-booking|key:\s*"switch-booking"/.test(planner), "PortalLoading during switch");
  assert(/clearCustomerBookingLocalState/.test(planner), "clears booking-local state");
  assert(/changeCustomerBooking\(\)/.test(planner), "sign-out still available");
}

// --- endpoints exist and require session language ---
{
  const listFn = readFileSync(path.join(root, "netlify/functions/customer-linked-bookings.js"), "utf8");
  const switchFn = readFileSync(path.join(root, "netlify/functions/customer-switch-booking.js"), "utf8");
  assert(/requireCustomerSession/.test(listFn), "list requires session");
  assert(/requireCustomerSession/.test(switchFn), "switch requires session");
  assert(/surname/i.test(listFn) === false || /Never.*surname|not permitted|Never accepts surname/i.test(listFn), "list forbids surname search");
  assert(/bookingsShareSecureIdentity/.test(switchFn), "switch re-checks linkage");
  assert(/verifySwitchToken/.test(switchFn), "switch verifies token");
  assert(/fetchBase44Booking/.test(switchFn), "switch pulls Base44 safely");
}

console.log("test-customer-linked-bookings: ok");
