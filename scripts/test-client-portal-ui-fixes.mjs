/**
 * Offline checks for Client Portal Documents scroll + packing/deck UI copy.
 * Run: node scripts/test-client-portal-ui-fixes.mjs
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const plannerSrc = readFileSync(path.join(root, "js/planner.js"), "utf8");
const cssSrc = readFileSync(path.join(root, "css/planner.css"), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/* Source-level UI placement */
assert(
  /packing-baggage-instruction/.test(plannerSrc) &&
    plannerSrc.includes(
      "Please add your airline baggage allowance below so the system can determine your capacity as you select what to pack."
    ),
  "baggage instruction present with required wording"
);
assert(
  /class="packing-baggage-instruction"/.test(plannerSrc),
  "baggage instruction uses subordinate class"
);

const deckIdx = plannerSrc.indexOf("Deck Plans");
const buttonIdx = plannerSrc.indexOf("ship-deck-button", deckIdx);
const mutedAfter = plannerSrc.indexOf("planner-muted", buttonIdx);
assert(deckIdx > -1 && buttonIdx > deckIdx, "Deck Plans button follows heading");
assert(mutedAfter > buttonIdx, "explanatory copy follows the Deck Plans button");
assert(
  /function renderShipDeckPlansSubsection/.test(plannerSrc),
  "deck plans rendered via shared subsection helper"
);
assert(
  !/ship-section-card ship-deck-card/.test(plannerSrc),
  "deck plans no longer uses standalone full-width card section"
);
assert(
  /grid-template-areas:[\s\S]*"exclusive"[\s\S]*"specialty"[\s\S]*"deckplans"/.test(cssSrc),
  "mobile stacks Exclusive Areas, Specialty Features, then Deck Plans"
);

assert(/scheduleScrollPlannerToTop\(\)/.test(plannerSrc), "Documents path schedules scroll-to-top");
assert(
  /async function renderDocuments\(/.test(plannerSrc) &&
    plannerSrc.includes("scheduleScrollPlannerToTop();"),
  "renderDocuments calls scroll reset"
);
assert(
  /function renderJourneySummary/.test(plannerSrc) && /renderJourneySummary\(mainCruise/.test(plannerSrc),
  "dashboard uses journey summary"
);
assert(
  !/resolveDashboardJourney\(mainCruise\)/.test(plannerSrc),
  "dashboard no longer loads approved itinerary map endpoint"
);
assert(
  !/Journey map coming soon/.test(plannerSrc.match(/function renderJourneySummary[\s\S]*?^}/m)?.[0] || ""),
  "summary does not show journey map coming soon"
);
assert(
  !/DASHBOARD_JOURNEY_PROTOTYPES/.test(plannerSrc),
  "old Millennium-only prototype map table removed"
);

assert(/\.packing-baggage-instruction\s*\{/.test(cssSrc), "baggage instruction CSS exists");
assert(/\.ship-deck-copy\s*\{[\s\S]*display:\s*grid/.test(cssSrc), "deck plans stack as column grid");

/* Behavioural scroll helper test with DOM stubs */
const scrollCalls = [];
const els = {
  scrollingElement: { scrollTo(x, y) { scrollCalls.push(["scrollingElement", x, y]); }, scrollTop: 120 },
  documentElement: { scrollTo(x, y) { scrollCalls.push(["documentElement", x, y]); }, scrollTop: 120 },
  body: { scrollTo(x, y) { scrollCalls.push(["body", x, y]); }, scrollTop: 80 },
  app: { scrollTo(x, y) { scrollCalls.push(["app", x, y]); }, scrollTop: 200 },
  plannerShell: { scrollTo(x, y) { scrollCalls.push(["plannerShell", x, y]); }, scrollTop: 90 },
  dashboardPage: { scrollTo(x, y) { scrollCalls.push(["dashboardPage", x, y]); }, scrollTop: 40 }
};

const sandbox = {
  console,
  app: els.app,
  window: {
    scrollTo(x, y) { scrollCalls.push(["window", x, y]); },
    requestAnimationFrame(cb) { return setTimeout(cb, 0); }
  },
  document: {
    scrollingElement: els.scrollingElement,
    documentElement: els.documentElement,
    body: els.body,
    getElementById(id) {
      if (id === "cruise-planner-app") return els.app;
      return null;
    },
    querySelector(sel) {
      if (sel === ".planner-shell") return els.plannerShell;
      if (sel === ".documents-header") return { closest() { return els.plannerShell; } };
      if (sel === ".dashboard-page") return els.dashboardPage;
      return null;
    }
  },
  setTimeout,
  clearTimeout,
  requestAnimationFrame(cb) { return setTimeout(cb, 0); }
};
sandbox.globalThis = sandbox;
const context = vm.createContext(sandbox);

const helperSrc = `
${plannerSrc.match(/function scrollPlannerViewportToTop\(\) \{[\s\S]*?\n\}/)[0]}
${plannerSrc.match(/function scheduleScrollPlannerToTop\(\) \{[\s\S]*?\n\}/)[0]}
`;
vm.runInContext(helperSrc, context);

context.scrollPlannerViewportToTop();
assert(scrollCalls.some((c) => c[0] === "window" && c[2] === 0), "window scrolled to top");
assert(els.app.scrollTop === 0, "app container scrollTop reset");
assert(els.plannerShell.scrollTop === 0, "internal planner-shell scrollTop reset");

scrollCalls.length = 0;
els.app.scrollTop = 300;
els.plannerShell.scrollTop = 250;
await new Promise((resolve) => {
  context.scheduleScrollPlannerToTop();
  setTimeout(resolve, 30);
});
assert(els.app.scrollTop === 0, "scheduled scroll resets after paint");
assert(els.plannerShell.scrollTop === 0, "scheduled scroll resets internal container");

/* Unrelated navigation should not auto-call scroll helper unless Documents renders */
const renderDashboardSnippet = plannerSrc.slice(
  plannerSrc.indexOf("async function renderDashboard"),
  plannerSrc.indexOf("async function renderDashboard") + 800
);
assert(
  !/scheduleScrollPlannerToTop/.test(renderDashboardSnippet),
  "unrelated dashboard navigation does not force Documents scroll helper"
);

console.log("test-client-portal-ui-fixes: ok");
