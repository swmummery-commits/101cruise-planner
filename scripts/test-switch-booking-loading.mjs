/**
 * Switch Cruise must show PortalLoading while finding linked bookings.
 * Run: node scripts/test-switch-booking-loading.mjs
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import vm from "vm";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const plannerSrc = readFileSync(path.join(root, "js/planner.js"), "utf8");
const portalSrc = readFileSync(path.join(root, "js/portal-loading.js"), "utf8");
const cssSrc = readFileSync(path.join(root, "css/planner.css"), "utf8");
const linkedFn = readFileSync(path.join(root, "netlify/functions/customer-linked-bookings.js"), "utf8");
const core = require("../netlify/functions/lib/customer-linked-bookings-core.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function extractFunction(src, name) {
  const patterns = [`async function ${name}(`, `function ${name}(`];
  let start = -1;
  for (const p of patterns) {
    start = src.indexOf(p);
    if (start >= 0) break;
  }
  assert(start >= 0, `missing ${name}`);
  // Skip default-parameter braces like `options = {}` — find the real body `{`
  const sigEnd = src.indexOf(")", start);
  assert(sigEnd > start, `missing signature end for ${name}`);
  let i = src.indexOf("{", sigEnd);
  assert(i > sigEnd, `missing body for ${name}`);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`extract failed ${name}`);
}

// --- Static wiring ---
{
  const openFn = extractFunction(plannerSrc, "openSwitchBookingChooser");
  assert(/PortalLoading\.withLoading/.test(openFn), "starts PortalLoading before chooser");
  assert(!/Finding your cruises/.test(openFn), "no custom finding message override");
  assert(!/Please wait while we check the cruises linked to your account/.test(openFn), "no custom support copy");
  assert(/delayMs:\s*0/.test(openFn), "no multi-second blank delay");
  assert(/switchBookingLoadInFlight/.test(openFn), "guards duplicate in-flight opens");
  assert(/find-linked-cruises/.test(openFn), "dedicated loading key");
  assert(/fetchCustomerLinkedBookings/.test(openFn), "fetches linked bookings under loading");
  assert(/openChooser/.test(openFn), "opens chooser after fetch");
}

{
  assert(/setSupportMessage/.test(portalSrc), "support message API");
  assert(/opts\.message/.test(portalSrc), "withLoading accepts message");
  assert(/portal-loading-support/.test(portalSrc), "support element in overlay");
  assert(/portal-loading-support/.test(cssSrc), "support styles");
  assert(/BrandLoading\.html|brand-loading-boxes/.test(portalSrc), "nine-square loader");
  assert(/101cruise-portal-loading-state|LOADING_STATE/.test(portalSrc), "parent viewport bridge");
}

{
  assert(/name=ilike/.test(linkedFn), "targeted ship hero lookup");
  assert(!/offset < 800/.test(linkedFn), "no full catalogue page loop");
  assert(/bookingsShareSecureIdentity|bookingIdentityKey/.test(linkedFn), "secure linkage retained");
  assert(/Never query by surname|rejectSurnameSearchBody/.test(linkedFn), "surname prohibited");
}

{
  assert(
    !core.bookingsShareSecureIdentity(
      { passenger1_email: null, passenger1_mobile: null, passenger1_last_name: "SMITH" },
      { passenger1_email: null, passenger1_mobile: null, passenger1_last_name: "SMITH" }
    ),
    "surname-only still never links"
  );
  const cards = core.buildLinkedBookingCards(
    {
      base44_booking_id: "a",
      booking_reference: "A1",
      passenger1_email: "a@example.com",
      passenger1_mobile: "61400111222",
      cruise_ship: "Ship",
      cruise_line: "Line",
      departing_date: "2026-09-01",
      arriving_date: "2026-09-08",
      departing_port: "A",
      arriving_port: "B"
    },
    [
      {
        base44_booking_id: "a",
        booking_reference: "A1",
        passenger1_email: "a@example.com",
        passenger1_mobile: "61400111222",
        cruise_ship: "Ship",
        cruise_line: "Line",
        departing_date: "2026-09-01",
        arriving_date: "2026-09-08",
        departing_port: "A",
        arriving_port: "B"
      }
    ],
    { secret: "test-secret" }
  );
  const json = JSON.stringify(cards);
  assert(!/passenger|email|mobile|price|balance/i.test(json), "no PII/finance in cards");
}

// --- Runtime: loading covers slow request; closes on success/error; duplicate blocked ---
{
  const events = [];
  let fetchCount = 0;
  let openCount = 0;
  let inFlight = false;

  const sandbox = {
    console,
    customerMode: true,
    customerSessionToken: "tok",
    switchBookingLoadInFlight: false,
    document: {
      querySelector() {
        return { disabled: false, classList: { add() {}, remove() {} } };
      }
    },
    changeCustomerBooking() {
      events.push("logout");
    },
    async fetchCustomerLinkedBookings() {
      fetchCount += 1;
      events.push("fetch-start");
      await new Promise((r) => setTimeout(r, 40));
      events.push("fetch-end");
      return {
        can_switch: true,
        bookings: [{ is_current: true }, { is_current: false, switch_token: "sw" }],
        loaded: true,
        error: null
      };
    },
    PortalLoading: {
      async withLoading(fn, opts) {
        events.push("loading-start");
        assert(!opts.message, "runtime uses canonical portal loading message");
        assert(opts.delayMs === 0, "runtime delay 0");
        try {
          return await fn();
        } finally {
          events.push("loading-end");
        }
      }
    },
    SwitchBooking: {
      openChooser() {
        openCount += 1;
        events.push("chooser-open");
      }
    }
  };

  vm.createContext(sandbox);
  const openSrc = extractFunction(plannerSrc, "openSwitchBookingChooser");
  vm.runInContext(openSrc + "\nthis.openSwitchBookingChooser = openSwitchBookingChooser;", sandbox);

  const p1 = sandbox.openSwitchBookingChooser();
  const p2 = sandbox.openSwitchBookingChooser(); // duplicate while in flight
  await Promise.all([p1, p2]);

  assert(fetchCount === 1, "duplicate click does not create second request");
  assert(openCount === 1, "chooser opened once");
  assert(events.indexOf("loading-start") < events.indexOf("fetch-start"), "loading before fetch");
  assert(events.indexOf("fetch-end") < events.indexOf("loading-end"), "loading stays until fetch done");
  assert(events.indexOf("loading-end") < events.indexOf("chooser-open"), "chooser after loading closes");
}

{
  const events = [];
  const sandbox = {
    console,
    customerMode: true,
    customerSessionToken: "tok",
    switchBookingLoadInFlight: false,
    document: { querySelector: () => null },
    changeCustomerBooking() {},
    async fetchCustomerLinkedBookings() {
      return { can_switch: false, bookings: [], loaded: true, error: "We couldn’t load your other cruises just now. Please try again." };
    },
    PortalLoading: {
      async withLoading(fn, opts) {
        events.push("loading-start");
        try {
          return await fn();
        } finally {
          events.push("loading-end");
        }
      }
    },
    SwitchBooking: {
      openChooser(opts) {
        events.push(`chooser:${opts.errorMessage ? "error" : "ok"}`);
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(
    extractFunction(plannerSrc, "openSwitchBookingChooser") +
      "\nthis.openSwitchBookingChooser = openSwitchBookingChooser;",
    sandbox
  );
  await sandbox.openSwitchBookingChooser({ force: true });
  assert(events.join(">").includes("loading-start>loading-end>chooser:error"), "loading closes after error then chooser");
}

{
  const events = [];
  const sandbox = {
    console,
    customerMode: true,
    customerSessionToken: "tok",
    switchBookingLoadInFlight: false,
    document: { querySelector: () => null },
    changeCustomerBooking() {},
    async fetchCustomerLinkedBookings() {
      return {
        can_switch: false,
        bookings: [{ is_current: true }],
        empty_message: "No other linked cruises are available in this account.",
        loaded: true
      };
    },
    PortalLoading: {
      async withLoading(fn) {
        events.push("loading-start");
        try {
          return await fn();
        } finally {
          events.push("loading-end");
        }
      }
    },
    SwitchBooking: {
      openChooser(opts) {
        events.push(`chooser:empty:${opts.emptyMessage ? "yes" : "no"}`);
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(
    extractFunction(plannerSrc, "openSwitchBookingChooser") +
      "\nthis.openSwitchBookingChooser = openSwitchBookingChooser;",
    sandbox
  );
  await sandbox.openSwitchBookingChooser({ force: true });
  assert(events.join(">").includes("loading-end>chooser:empty:yes"), "loading closes after single/empty result");
}

console.log("test-switch-booking-loading: ok");
