/**
 * Offline tests for multi-currency On-Board Credit (OBC).
 * Run: node scripts/test-on-board-credits.mjs
 */

import { createRequire } from "module";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const Contract = require("../js/base44-booking-field-contract.js");
const Finance = require("../base44/bookingFinance.js");
const { buildGetBookingResponse } = require("../base44/getBookingFor101Cruise.snippet.js");
const { buildPushBookingPayload } = require("../base44/pushBookingTo101Cruise.snippet.js");
const { applySafeBookingFinance, bookingFromCacheRow } = require("../netlify/functions/booking-service.js");
const { buildAddBookingObcPayload, OBC_CURRENCY_OPTIONS } = require("../base44/addBookingObc.js");
const { getOnBoardCreditPdfRows } = require("../base44/generateBookingPdf.snippet.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertDeepEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}\n  actual:   ${a}\n  expected: ${b}`);
}

const MIXED = {
  booking_reference: "OBCMIX01",
  passenger1_last_name: "Example",
  cruise_price_usd: 4000,
  cruise_deposit: 500,
  cruise_deposit_date: "2026-07-01",
  on_board_credit_usd: 500,
  on_board_credit_1_currency: "USD",
  on_board_credit_2_amount: 200,
  on_board_credit_2_currency: "EUR"
};

const OBC_FIELDS = [
  "on_board_credit_usd",
  "on_board_credit_1_currency",
  "on_board_credit_2_amount",
  "on_board_credit_2_currency",
  "on_board_credits"
];

const FORBIDDEN = Contract.FORBIDDEN_SENSITIVE_FIELDS;

// --- contract whitelist ---
{
  for (const field of OBC_FIELDS) {
    assert(Contract.SAFE_OBC_FIELDS.includes(field), `SAFE_OBC_FIELDS has ${field}`);
    assert(Contract.SAFE_BOOKING_CORE_FIELDS.includes(field), `core whitelist has ${field}`);
    assert(Contract.SAFE_PUSH_FIELDS.includes(field), `push whitelist has ${field}`);
  }
  for (const bad of FORBIDDEN) {
    assert(!OBC_FIELDS.includes(bad), "OBC list is not a sensitive field");
  }
}

// --- no OBC ---
{
  const credits = Contract.normalizeOnBoardCredits({
    on_board_credit_usd: null,
    on_board_credit_2_amount: null
  });
  assertDeepEqual(credits, [], "no OBC → empty array");
}

// --- single USD ---
{
  const credits = Contract.normalizeOnBoardCredits({
    on_board_credit_usd: 500,
    on_board_credit_1_currency: "USD"
  });
  assertDeepEqual(credits, [{ amount: 500, currency: "USD" }], "single USD");
}

// --- single EUR in legacy #1 field (name must NOT force USD) ---
{
  const credits = Contract.normalizeOnBoardCredits({
    on_board_credit_usd: 200,
    on_board_credit_1_currency: "EUR"
  });
  assertDeepEqual(credits, [{ amount: 200, currency: "EUR" }], "legacy #1 EUR is EUR");
  assert(credits[0].currency !== "USD", "field name on_board_credit_usd does not force USD");
}

// --- mixed currency ---
{
  const credits = Contract.normalizeOnBoardCredits(MIXED);
  assertDeepEqual(
    credits,
    [
      { amount: 500, currency: "USD" },
      { amount: 200, currency: "EUR" }
    ],
    "mixed USD + EUR"
  );
}

// --- two same-currency credits stay separate ---
{
  const credits = Contract.normalizeOnBoardCredits({
    on_board_credit_usd: 100,
    on_board_credit_1_currency: "AUD",
    on_board_credit_2_amount: 100,
    on_board_credit_2_currency: "AUD"
  });
  assert(credits.length === 2, "two same-currency credits remain");
  assertDeepEqual(
    credits,
    [
      { amount: 100, currency: "AUD" },
      { amount: 100, currency: "AUD" }
    ],
    "identical AUD awards are not deduped"
  );
}

// --- remaining currency pairs ---
{
  assertDeepEqual(
    Contract.normalizeOnBoardCredits({
      on_board_credit_usd: 150,
      on_board_credit_1_currency: "AUD"
    }),
    [{ amount: 150, currency: "AUD" }],
    "single AUD"
  );
  assertDeepEqual(
    Contract.normalizeOnBoardCredits({
      on_board_credit_usd: 500,
      on_board_credit_1_currency: "USD",
      on_board_credit_2_amount: 150,
      on_board_credit_2_currency: "AUD"
    }),
    [
      { amount: 500, currency: "USD" },
      { amount: 150, currency: "AUD" }
    ],
    "USD + AUD"
  );
  assertDeepEqual(
    Contract.normalizeOnBoardCredits({
      on_board_credit_usd: 200,
      on_board_credit_1_currency: "EUR",
      on_board_credit_2_amount: 150,
      on_board_credit_2_currency: "AUD"
    }),
    [
      { amount: 200, currency: "EUR" },
      { amount: 150, currency: "AUD" }
    ],
    "EUR + AUD"
  );
}

// --- numeric strings, empty, zero, malformed ---
{
  assertDeepEqual(
    Contract.normalizeOnBoardCredits({
      on_board_credit_usd: "500",
      on_board_credit_1_currency: "usd"
    }),
    [{ amount: 500, currency: "USD" }],
    "numeric string + lowercase currency"
  );
  assertDeepEqual(
    Contract.normalizeOnBoardCredits({
      on_board_credit_usd: "",
      on_board_credit_2_amount: 0
    }),
    [],
    "blank and zero are omitted"
  );
  assertDeepEqual(
    Contract.normalizeOnBoardCredits({
      on_board_credit_usd: "abc",
      on_board_credit_2_amount: undefined
    }),
    [],
    "malformed does not throw and is omitted"
  );
  assertDeepEqual(
    Contract.normalizeOnBoardCredits({
      on_board_credit_usd: "  ",
      on_board_credit_1_currency: "",
      on_board_credit_2_amount: "0.00"
    }),
    [],
    "whitespace / zero-string omitted"
  );
}

// --- absent currency #1 falls back to USD; does not infer from field name when present ---
{
  const missing = Contract.normalizeOnBoardCredits({ on_board_credit_usd: 80 });
  assertDeepEqual(missing, [{ amount: 80, currency: "USD" }], "absent #1 currency → USD");
  const missing2 = Contract.normalizeOnBoardCredits({
    on_board_credit_usd: 80,
    on_board_credit_1_currency: "EUR",
    on_board_credit_2_amount: 40
  });
  assertDeepEqual(
    missing2,
    [
      { amount: 80, currency: "EUR" },
      { amount: 40, currency: "USD" }
    ],
    "absent #2 currency uses CRM default USD"
  );
}

// --- future currency codes are preserved ---
{
  const credits = Contract.normalizeOnBoardCredits({
    on_board_credit_usd: 75,
    on_board_credit_1_currency: "gbp"
  });
  assertDeepEqual(credits, [{ amount: 75, currency: "GBP" }], "future GBP preserved");
}

// --- future 3+ credits in on_board_credits survive ---
{
  const credits = Contract.normalizeOnBoardCredits({
    on_board_credit_usd: 10,
    on_board_credit_1_currency: "USD",
    on_board_credit_2_amount: 20,
    on_board_credit_2_currency: "EUR",
    on_board_credits: [
      { amount: 10, currency: "USD" },
      { amount: 20, currency: "EUR" },
      { amount: 30, currency: "AUD" }
    ]
  });
  assert(credits.length === 3, "third credit from array is kept");
  assert(credits[2].currency === "AUD" && credits[2].amount === 30, "AUD 30 extra");
}

// --- finance helpers stay aligned and ignore OBC ---
{
  const financed = Finance.applyBookingFinance(MIXED);
  const derived = Contract.derivePaymentFields(MIXED);
  assertDeepEqual(
    financed.on_board_credits,
    [
      { amount: 500, currency: "USD" },
      { amount: 200, currency: "EUR" }
    ],
    "applyBookingFinance emits on_board_credits"
  );
  assert(derived.amount_received === 500, "OBC does not change amount_received");
  assert(derived.balance_owing === 3500, "OBC does not change balance_owing");
  assert(financed.amount_received === 500, "finance helper amount_received unchanged");
  assert(financed.balance_owing === 3500, "finance helper balance_owing unchanged");
}

// --- pull / push payloads include raw + normalised OBC and no sensitive fields ---
{
  const pull = Contract.buildPullPayload({
    ...MIXED,
    passenger1_passport: "X123",
    notes: "private",
    commission: 99
  });
  assert(pull.on_board_credit_usd === 500, "pull raw #1 amount");
  assert(pull.on_board_credit_1_currency === "USD", "pull raw #1 currency");
  assert(pull.on_board_credit_2_amount === 200, "pull raw #2 amount");
  assert(pull.on_board_credit_2_currency === "EUR", "pull raw #2 currency");
  assertDeepEqual(
    pull.on_board_credits,
    [
      { amount: 500, currency: "USD" },
      { amount: 200, currency: "EUR" }
    ],
    "pull normalised array"
  );
  assert(!("passenger1_passport" in pull), "pull strips passport");
  assert(!("notes" in pull), "pull strips notes");
  assert(!("commission" in pull), "pull strips commission");

  const push = Contract.buildPushPayload({
    ...MIXED,
    passenger1_passport: "X123",
    internal_notes: "nope"
  });
  for (const field of OBC_FIELDS) {
    assert(Object.prototype.hasOwnProperty.call(push, field), `push has ${field}`);
  }
  assertDeepEqual(
    push.on_board_credits,
    [
      { amount: 500, currency: "USD" },
      { amount: 200, currency: "EUR" }
    ],
    "push normalised array"
  );
  assert(!("passenger1_passport" in push), "push strips passport");
  assert(!("internal_notes" in push), "push strips notes");
}

// --- Base44 snippet adapters ---
{
  const { booking } = buildGetBookingResponse({
    ...MIXED,
    passenger1_passport: "SECRET"
  });
  assertDeepEqual(
    booking.on_board_credits,
    [
      { amount: 500, currency: "USD" },
      { amount: 200, currency: "EUR" }
    ],
    "getBooking snippet mixed OBC"
  );
  assert(booking.on_board_credit_2_currency === "EUR", "getBooking snippet raw #2");
  assert(!("passenger1_passport" in booking), "getBooking snippet no passport");

  const pushed = buildPushBookingPayload({
    ...MIXED,
    commission_amount: 12
  });
  assertDeepEqual(
    pushed.on_board_credits,
    [
      { amount: 500, currency: "USD" },
      { amount: 200, currency: "EUR" }
    ],
    "push snippet mixed OBC"
  );
  assert(!("commission_amount" in pushed), "push snippet no commission");
}

// --- Netlify live + cache fallback ---
{
  const live = applySafeBookingFinance({ ...MIXED });
  assertDeepEqual(
    live.on_board_credits,
    [
      { amount: 500, currency: "USD" },
      { amount: 200, currency: "EUR" }
    ],
    "live Base44 path normalises OBC"
  );
  assert(!("_meta" in live), "live path strips finance _meta");

  const cachedLegacy = bookingFromCacheRow({
    raw_payload: {
      booking_reference: "OBCMIX01",
      passenger1_last_name: "Example",
      on_board_credit_usd: 500,
      on_board_credit_1_currency: "USD",
      on_board_credit_2_amount: 200,
      on_board_credit_2_currency: "EUR"
    }
  });
  assertDeepEqual(
    cachedLegacy.on_board_credits,
    live.on_board_credits,
    "cached legacy raw fields match live on_board_credits"
  );
}

// --- customer-access / refresh return the booking object as-is ---
{
  const accessSrc = readFileSync(path.join(root, "netlify/functions/customer-access.js"), "utf8");
  const refreshSrc = readFileSync(path.join(root, "netlify/functions/customer-refresh-booking.js"), "utf8");
  assert(/return jsonResponse\(200, \{ success: true, token, booking \}\)/.test(accessSrc), "customer-access returns booking");
  assert(/return jsonResponse\(200, \{ success: true, booking \}\)/.test(refreshSrc), "customer-refresh returns booking");
  assert(/fetchBase44Booking|resolveCustomerBooking/.test(accessSrc), "customer-access uses booking-service");
  assert(/fetchBase44Booking/.test(refreshSrc), "customer-refresh uses booking-service");
}

// --- Add Booking payload mapping ---
{
  assertDeepEqual(OBC_CURRENCY_OPTIONS, ["USD", "AUD", "EUR"], "Add Booking currencies");
  const payload = buildAddBookingObcPayload({
    on_board_credit_usd: "500",
    on_board_credit_1_currency: "usd",
    on_board_credit_2_amount: "200",
    on_board_credit_2_currency: "EUR"
  });
  assert(payload.on_board_credit_usd === 500, "Add Booking #1 amount");
  assert(payload.on_board_credit_1_currency === "USD", "Add Booking #1 currency");
  assert(payload.on_board_credit_2_amount === 200, "Add Booking #2 amount");
  assert(payload.on_board_credit_2_currency === "EUR", "Add Booking #2 currency");
  const empty = buildAddBookingObcPayload({
    on_board_credit_usd: "",
    on_board_credit_2_amount: "0"
  });
  assert(empty.on_board_credit_usd == null, "Add Booking blank #1");
  assert(empty.on_board_credit_2_amount == null, "Add Booking zero #2");
}

// --- PDF rows are currency-aware and omit $0.00 ---
{
  const mixedRows = getOnBoardCreditPdfRows(MIXED);
  assert(mixedRows.length === 2, "PDF has two OBC rows");
  assert(mixedRows[0][1] === "USD 500.00", "PDF row 1 USD 500.00");
  assert(mixedRows[1][1] === "EUR 200.00", "PDF row 2 EUR 200.00");
  assert(!mixedRows.some((row) => String(row[1]).includes("$")), "PDF does not use $ for OBC");
  assert(!mixedRows.some((row) => /700/.test(String(row[1]))), "PDF has no cross-currency total");

  const none = getOnBoardCreditPdfRows({ on_board_credit_usd: null, on_board_credit_2_amount: 0 });
  assertDeepEqual(none, [], "PDF omits empty/zero OBC");

  const eurOnly = getOnBoardCreditPdfRows({
    on_board_credit_usd: 200,
    on_board_credit_1_currency: "EUR"
  });
  assert(eurOnly.length === 1 && eurOnly[0][1] === "EUR 200.00", "PDF EUR in slot #1");
}

// --- labels never use a bare $ ---
{
  assert(Contract.formatOnBoardCreditLabel({ amount: 500, currency: "USD" }) === "USD 500.00", "USD label");
  assert(Contract.formatOnBoardCreditLabel({ amount: 200, currency: "EUR" }) === "EUR 200.00", "EUR label");
  assert(Contract.formatOnBoardCreditLabel({ amount: 150, currency: "AUD" }) === "AUD 150.00", "AUD label");
}

// --- shared UI renderer: dashboard + booking page ---
{
  const dashboardHtml = Contract.renderOnBoardCreditsSectionHtml(MIXED, { headingTag: "h3" });
  const bookingHtml = Contract.renderOnBoardCreditsSectionHtml(MIXED, {
    headingTag: "h4",
    extraClass: "booking-snapshot-extras"
  });
  for (const [label, html] of [
    ["dashboard", dashboardHtml],
    ["booking", bookingHtml]
  ]) {
    assert(html.includes("On-board credit"), `${label} has OBC heading`);
    assert(html.includes("USD 500.00"), `${label} shows USD 500.00`);
    assert(html.includes("EUR 200.00"), `${label} shows EUR 200.00`);
    assert(!/700/.test(html), `${label} has no 700 total`);
    assert(!html.includes("$500"), `${label} does not show ambiguous $500`);
    assert(!html.includes("$200"), `${label} does not show ambiguous $200`);
  }
  assert(dashboardHtml.includes("<h3"), "dashboard uses h3");
  assert(bookingHtml.includes("<h4"), "booking page uses h4");
  assert(Contract.renderOnBoardCreditsSectionHtml({ on_board_credit_usd: null }) === "", "no empty OBC section");
}

// --- planner.js uses the shared renderer on both surfaces ---
{
  const plannerSrc = readFileSync(path.join(root, "js/planner.js"), "utf8");
  const indexSrc = readFileSync(path.join(root, "index.html"), "utf8");
  assert(/function renderOnBoardCreditsSection\(/.test(plannerSrc), "planner has shared OBC renderer");
  assert(
    /function renderDashboardSnapshot[\s\S]*renderOnBoardCreditsSection\(booking\)/.test(plannerSrc),
    "dashboard Cruise Snapshot renders OBC"
  );
  assert(
    /function renderBookingCruiseSection[\s\S]*renderOnBoardCreditsSection\(booking/.test(plannerSrc),
    "Booking page renders OBC"
  );
  assert(
    /renderOnBoardCreditsSection\(booking\)/.test(plannerSrc) &&
      /renderOnBoardCreditsSection\(booking, \{ headingTag: "h4"/.test(plannerSrc),
    "both surfaces call the same helper"
  );
  assert(
    !/renderDashboardInclusionTags[\s\S]{0,80}on_board/.test(plannerSrc),
    "OBC is not stuffed into inclusion tags"
  );
  assert(/base44-booking-field-contract\.js/.test(indexSrc), "index still loads contract");
}

// --- no new dedicated OBC table / migration ---
{
  const serviceSrc = readFileSync(path.join(root, "netlify/functions/booking-service.js"), "utf8");
  assert(/raw_payload: booking/.test(serviceSrc), "cache still stores complete booking as raw_payload");
  assert(!/create table.*on_board/i.test(serviceSrc), "booking-service has no OBC table");
}

console.log("test-on-board-credits: ok");
console.log(
  JSON.stringify(
    {
      mixed: Contract.normalizeOnBoardCredits(MIXED),
      labels: MIXED.on_board_credits
        ? null
        : Contract.normalizeOnBoardCredits(MIXED).map(Contract.formatOnBoardCreditLabel)
    },
    null,
    2
  )
);
