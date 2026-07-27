/**
 * Boundary tests for cruise-date-state lifecycle helpers.
 * Run: node scripts/test-cruise-date-state.mjs
 */

import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  parseDateOnly,
  addDays,
  deriveReturnDate,
  getCruiseLifecycleState,
  buildCountdownPresentation,
  formatDateOnly
} = require("../js/cruise-date-state.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const DEPART = "2026-09-15";
const ARRIVE = "2026-09-22";

const NOW_BEFORE = new Date(2026, 8, 10, 12, 0, 0);
const NOW_EMBARK = new Date(2026, 8, 15, 8, 30, 0);
const NOW_DURING = new Date(2026, 8, 18, 15, 0, 0);
const NOW_DISEMBARK = new Date(2026, 8, 22, 6, 0, 0);
const NOW_AFTER = new Date(2026, 8, 25, 9, 0, 0);

assert(parseDateOnly("2026-09-15") instanceof Date, "parseDateOnly returns Date");
assert(parseDateOnly("2026-09-15T18:00:00Z").getDate() === 15, "parseDateOnly ignores time portion");
assert(parseDateOnly("2026-09-15").getHours() === 0, "parseDateOnly uses local midnight");
assert(parseDateOnly("invalid") === null, "invalid iso returns null");

const plusSeven = addDays(parseDateOnly(DEPART), 7);
assert(formatDateOnly(plusSeven) === ARRIVE, "addDays adds calendar days");

assert(
  deriveReturnDate({ departing_date: DEPART, arriving_date: ARRIVE }).returnDate === ARRIVE &&
    deriveReturnDate({ departing_date: DEPART, arriving_date: ARRIVE }).derived === false,
  "deriveReturnDate prefers arriving_date"
);

const derived = deriveReturnDate({
  departing_date: DEPART,
  cruise_duration: "7 nights"
});
assert(derived.returnDate === ARRIVE && derived.derived === true, "deriveReturnDate derives from duration");

assert(
  deriveReturnDate({ departing_date: DEPART, nights: 14 }).returnDate === "2026-09-29",
  "deriveReturnDate accepts numeric nights"
);

const baseArgs = { departing_date: DEPART, arriving_date: ARRIVE };

assert(
  getCruiseLifecycleState({ ...baseArgs, now: NOW_BEFORE }) === "before_embarkation",
  "before embarkation calendar day"
);
assert(
  getCruiseLifecycleState({ ...baseArgs, now: NOW_EMBARK }) === "embarkation_day",
  "embarkation day"
);
assert(
  getCruiseLifecycleState({ ...baseArgs, now: NOW_DURING }) === "during_cruise",
  "during cruise"
);
assert(
  getCruiseLifecycleState({ ...baseArgs, now: NOW_DISEMBARK }) === "disembarked",
  "disembarkation day"
);
assert(
  getCruiseLifecycleState({ ...baseArgs, now: NOW_AFTER }) === "disembarked",
  "after disembarkation"
);
assert(
  getCruiseLifecycleState({ departing_date: "not-a-date", now: NOW_BEFORE }) === "hidden",
  "invalid departure is hidden"
);

const derivedState = getCruiseLifecycleState({
  departing_date: DEPART,
  cruise_duration: 7,
  now: NOW_DURING
});
assert(derivedState === "during_cruise", "during cruise with derived return date");

const derivedDisembark = getCruiseLifecycleState({
  departing_date: DEPART,
  cruise_duration: 7,
  now: NOW_DISEMBARK
});
assert(derivedDisembark === "disembarked", "disembarked with derived return date");

const countdownBefore = buildCountdownPresentation("before_embarkation", {
  panelLabel: "Embarkation in"
});
assert(
  countdownBefore.mode === "countdown" &&
    countdownBefore.panelLabel === "Embarkation in" &&
    countdownBefore.showCounters === true,
  "before_embarkation presentation"
);

const sailDay = buildCountdownPresentation("embarkation_day");
assert(
  sailDay.mode === "sail_day" &&
    sailDay.message.title === "TODAY IS SAIL DAY" &&
    sailDay.message.subtitle === "BON VOYAGE!" &&
    sailDay.showCounters === false,
  "embarkation_day presentation"
);

const enjoying = buildCountdownPresentation("during_cruise");
assert(
  enjoying.mode === "enjoying" &&
    enjoying.message === "HOPE YOU ARE ENJOYING YOUR CRUISE" &&
    enjoying.showCounters === false,
  "during_cruise presentation"
);

const hidden = buildCountdownPresentation("disembarked");
assert(hidden.mode === "hidden" && hidden.showCounters === false, "disembarked hides panel");
assert(buildCountdownPresentation("hidden").mode === "hidden", "hidden hides panel");

console.log("test-cruise-date-state: ok");
