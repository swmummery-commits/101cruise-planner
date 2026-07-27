/**
 * Experience tests for Switch Booking chooser UI.
 * Run: node scripts/test-switch-booking-ui.mjs
 */

import { createRequire } from "module";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const SwitchBooking = require("../js/switch-booking.js");
const core = require("../netlify/functions/lib/customer-linked-bookings-core.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const SECRET = "ui-test-secret";

function makeBookings() {
  return core.buildLinkedBookingCards(
    {
      base44_booking_id: "cur",
      booking_reference: "CUR-1",
      passenger1_email: "guest@example.com",
      passenger1_mobile: "61400111222",
      cruise_line: "Celebrity Cruises",
      cruise_ship: "Celebrity Edge",
      departing_date: "2026-09-01",
      arriving_date: "2026-09-08",
      departing_port: "Barcelona",
      arriving_port: "Rome"
    },
    [
      {
        base44_booking_id: "cur",
        booking_reference: "CUR-1",
        passenger1_email: "guest@example.com",
        passenger1_mobile: "61400111222",
        cruise_line: "Celebrity Cruises",
        cruise_ship: "Celebrity Edge",
        departing_date: "2026-09-01",
        arriving_date: "2026-09-08",
        departing_port: "Barcelona",
        arriving_port: "Rome"
      },
      {
        base44_booking_id: "oth",
        booking_reference: "OTH-2",
        passenger1_email: "guest@example.com",
        passenger1_mobile: "61400111222",
        cruise_line: "Royal Caribbean",
        cruise_ship: "Wonder of the Seas",
        departing_date: "2027-02-01",
        arriving_date: "2027-02-08",
        departing_port: "Miami",
        arriving_port: "Miami"
      },
      {
        base44_booking_id: "old",
        booking_reference: "OLD-3",
        passenger1_email: "guest@example.com",
        passenger1_mobile: "61400111222",
        cruise_line: "P&O Cruises",
        cruise_ship: "Pacific Adventure",
        departing_date: "2025-03-01",
        arriving_date: "2025-03-08",
        departing_port: "Sydney",
        arriving_port: "Sydney"
      }
    ],
    { secret: SECRET, now: new Date("2026-07-27T12:00:00Z") }
  );
}

{
  const bookings = makeBookings();
  assert(bookings.length === 3, "several linked bookings");
  assert(bookings.some((b) => b.lifecycle === "completed"), "includes completed");
  assert(bookings[bookings.length - 1].lifecycle === "completed", "completed sorted last");
  assert(SwitchBooking.shouldShowSwitchControl({ can_switch: true, bookings }) === true, "show for several");
  assert(SwitchBooking.shouldShowSwitchControl({ can_switch: false, bookings: bookings.slice(0, 1) }) === false, "hide for one");
  assert(SwitchBooking.shouldShowSwitchControl({ can_switch: false, bookings: [] }) === false, "hide for zero");
}

{
  const bookings = makeBookings();
  let selected = null;
  let closed = false;
  let signedOut = false;
  const nodes = [];
  const sandboxDoc = {
    body: {
      style: { overflow: "" },
      appendChild(el) {
        nodes.push(el);
      }
    },
    documentElement: {
      classList: {
        add() {},
        remove() {}
      }
    },
    getElementById(id) {
      return nodes.find((n) => n.id === id) || null;
    },
    createElement(tag) {
      const el = {
        tagName: tag,
        id: "",
        className: "",
        innerHTML: "",
        style: {},
        parentNode: {
          removeChild(child) {
            const idx = nodes.indexOf(child);
            if (idx >= 0) nodes.splice(idx, 1);
          }
        },
        setAttribute() {},
        getAttribute(name) {
          return el._attrs?.[name] || null;
        },
        _attrs: {},
        querySelector() {
          return { focus() {} };
        },
        querySelectorAll() {
          return [];
        },
        addEventListener(type, fn) {
          el._listeners = el._listeners || {};
          el._listeners[type] = fn;
        },
        closest() {
          return null;
        }
      };
      el.setAttribute = function (k, v) {
        el._attrs[k] = v;
      };
      return el;
    },
    addEventListener() {},
    removeEventListener() {}
  };

  const context = { document: sandboxDoc, window: {}, module: { exports: {} }, exports: {} };
  vm.createContext(context);
  vm.runInContext(readFileSync(path.join(root, "js/switch-booking.js"), "utf8"), context);
  const SB = context.module.exports;

  SB.openChooser({
    bookings,
    onSelect(token) {
      selected = token;
    },
    onSignOut() {
      signedOut = true;
    },
    onClose() {
      closed = true;
    }
  });

  assert(nodes.length === 1, "overlay mounted");
  const html = nodes[0].innerHTML;
  assert(/Choose your cruise/.test(html), "heading rendered");
  assert(/Celebrity Edge/.test(html), "ship rendered");
  assert(/Celebrity Cruises/.test(html), "line rendered");
  assert(/Barcelona/.test(html), "route rendered");
  assert(/Current cruise/.test(html), "current marked");
  assert(/Open this cruise/.test(html), "open action present");
  assert(!/Lead traveller surname/.test(html), "no login surname field");
  assert(!/customerBookingNumber|Open My Cruise/.test(html), "not the login form");

  // Closing without select
  SB.closeChooser();
  assert(selected === null, "close makes no booking change");
  assert(nodes.length === 0, "overlay removed");
}

{
  const css = readFileSync(path.join(root, "css/planner.css"), "utf8");
  assert(/\.switch-booking-overlay/.test(css), "overlay styles");
  assert(/\.switch-booking-card/.test(css), "card styles");
  assert(/@media \(max-width: 520px\)/.test(css), "mobile sheet styles present");
  assert(/#8dd9bf|#8DD9BF/i.test(css.match(/switch-booking[\s\S]{0,2500}/)?.[0] || ""), "brand green focus");
}

{
  const planner = readFileSync(path.join(root, "js/planner.js"), "utf8");
  assert(/key:\s*"switch-booking"/.test(planner), "loading key during switch");
  assert(/scrollTo\(0,\s*0\)/.test(planner), "returns to dashboard top");
  assert(/previousSession/.test(planner), "keeps prior session on failure");
}

console.log("test-switch-booking-ui: ok");
