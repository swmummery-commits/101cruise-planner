/**
 * Regression checks for the temporary Base44 preview OBC transport bridge.
 * Run: node scripts/test-obc-preview-bridge.mjs
 */

import { createRequire } from "module";

const require = createRequire(import.meta.url);

process.env.BASE44_BOOKING_FUNCTION_URL = "https://example.test/api/apps/test/functions/getBookingFor101Cruise";
process.env.BASE44_API_KEY = "test-key";

const {
  OBC_CONTRACT_FIELDS,
  bookingHasObcContract,
  mergeObcContractFields,
  fetchBase44Booking
} = require("../netlify/functions/booking-service.js");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}\nactual:   ${a}\nexpected: ${b}`);
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    }
  };
}

assertDeepEqual(
  OBC_CONTRACT_FIELDS,
  [
    "on_board_credit_usd",
    "on_board_credit_1_currency",
    "on_board_credit_2_amount",
    "on_board_credit_2_currency",
    "on_board_credits"
  ],
  "bridge whitelist is OBC-only"
);

assert(
  !bookingHasObcContract({ booking_reference: "OLD" }),
  "legacy published payload without OBC keys is detected"
);
assert(
  bookingHasObcContract({ on_board_credit_usd: null, on_board_credits: [] }),
  "current OBC-aware payload is detected even when booking has no credit"
);

{
  const merged = mergeObcContractFields(
    {
      passenger1_last_name: "SMALL",
      cruise_price_usd: 8840,
      departing_port: "Barcelona",
      documents: [{ id: "published-doc" }]
    },
    {
      passenger1_last_name: "DRAFT-NAME-MUST-NOT-LEAK",
      cruise_price_usd: 1,
      departing_port: "Draft Port",
      documents: [{ id: "draft-doc" }],
      on_board_credit_usd: 500,
      on_board_credit_1_currency: "USD",
      on_board_credit_2_amount: 200,
      on_board_credit_2_currency: "EUR",
      on_board_credits: [
        { amount: 500, currency: "USD" },
        { amount: 200, currency: "EUR" }
      ]
    }
  );

  assert(merged.passenger1_last_name === "SMALL", "preview cannot overwrite passenger identity");
  assert(merged.cruise_price_usd === 8840, "preview cannot overwrite cruise price");
  assert(merged.departing_port === "Barcelona", "preview cannot overwrite itinerary");
  assert(merged.documents?.[0]?.id === "published-doc", "preview cannot overwrite documents");
  assertDeepEqual(
    merged.on_board_credits,
    [
      { amount: 500, currency: "USD" },
      { amount: 200, currency: "EUR" }
    ],
    "preview supplies mixed-currency OBC"
  );
}

{
  const calls = [];
  const published = {
    success: true,
    booking: {
      base44_booking_id: "booking-1",
      booking_reference: "10175811",
      passenger1_last_name: "SMALL",
      cruise_price_usd: 8840,
      cruise_deposit: 8840,
      cruise_deposit_date: "2026-07-22",
      departing_port: "Barcelona",
      documents: [{ id: "published-doc" }]
    }
  };
  const preview = {
    success: true,
    booking: {
      ...published.booking,
      passenger1_last_name: "DRAFT-NAME-MUST-NOT-LEAK",
      cruise_price_usd: 1,
      departing_port: "Draft Port",
      documents: [{ id: "draft-doc" }],
      on_board_credit_usd: 500,
      on_board_credit_1_currency: "USD",
      on_board_credit_2_amount: 200,
      on_board_credit_2_currency: "EUR",
      on_board_credits: [
        { amount: 500, currency: "USD" },
        { amount: 200, currency: "EUR" }
      ]
    }
  };

  const fetchImpl = async (_url, options) => {
    calls.push(options);
    return jsonResponse(calls.length === 1 ? published : preview);
  };

  const { booking } = await fetchBase44Booking({ booking_reference: "10175811", fetchImpl });

  assert(calls.length === 2, "legacy published response triggers one preview OBC request");
  assert(!calls[0].headers["Base44-Functions-Version"], "published request has no preview override");
  assert(calls[1].headers["Base44-Functions-Version"] === "preview", "fallback request targets preview function version");
  assert(calls[1].headers["x-api-key"] === "test-key", "preview request preserves server API authentication");
  assert(booking.passenger1_last_name === "SMALL", "final booking keeps published passenger identity");
  assert(booking.cruise_price_usd === 8840, "final booking keeps published cruise price");
  assert(booking.departing_port === "Barcelona", "final booking keeps published itinerary");
  assert(booking.documents?.[0]?.id === "published-doc", "final booking keeps published documents");
  assertDeepEqual(
    booking.on_board_credits,
    [
      { amount: 500, currency: "USD" },
      { amount: 200, currency: "EUR" }
    ],
    "final booking contains USD 500 + EUR 200 separately"
  );
  assert(booking.amount_received === 8840, "OBC does not change amount received");
  assert(booking.balance_owing === 0, "OBC does not change balance owing");
}

{
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({
      success: true,
      booking: {
        base44_booking_id: "booking-no-obc",
        booking_reference: "NOOBC",
        on_board_credit_usd: null,
        on_board_credit_1_currency: "USD",
        on_board_credit_2_amount: null,
        on_board_credit_2_currency: "USD",
        on_board_credits: []
      }
    });
  };

  const { booking } = await fetchBase44Booking({ booking_reference: "NOOBC", fetchImpl });
  assert(calls === 1, "current OBC-aware published response does not call preview");
  assertDeepEqual(booking.on_board_credits, [], "true no-OBC booking remains empty");
}

{
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return jsonResponse({
        success: true,
        booking: {
          base44_booking_id: "booking-fallback-failure",
          booking_reference: "SAFE",
          passenger1_last_name: "SMALL",
          cruise_price_usd: 8840
        }
      });
    }
    return jsonResponse({ success: false, error: "Preview unavailable" }, 503);
  };

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const { booking } = await fetchBase44Booking({ booking_reference: "SAFE", fetchImpl });
    assert(booking.booking_reference === "SAFE", "preview failure does not block valid published booking");
    assertDeepEqual(booking.on_board_credits, [], "preview failure safely leaves OBC empty");
  } finally {
    console.warn = originalWarn;
  }
}

console.log("test-obc-preview-bridge: ok");
