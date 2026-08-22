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
const shipPresentationSrc = readFileSync(path.join(root, "js/ci-ship-presentation.js"), "utf8");
const cssSrc = readFileSync(path.join(root, "css/planner.css"), "utf8");
const shipCssSrc = readFileSync(path.join(root, "css/ci-ship-presentation.css"), "utf8");

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

const deckIdx = shipPresentationSrc.indexOf("Deck Plans");
const buttonIdx = shipPresentationSrc.indexOf("ship-deck-button", deckIdx);
const mutedAfter = shipPresentationSrc.indexOf("planner-muted", buttonIdx);
assert(deckIdx > -1 && buttonIdx > deckIdx, "Deck Plans button follows heading");
assert(mutedAfter > buttonIdx, "explanatory copy follows the Deck Plans button");
assert(
  /function renderShipDeckPlansSubsection/.test(shipPresentationSrc),
  "deck plans rendered via shared subsection helper"
);
assert(
  !/ship-section-card ship-deck-card/.test(shipPresentationSrc),
  "deck plans no longer uses standalone full-width card section"
);
assert(
  /grid-template-areas:[\s\S]*"exclusive"[\s\S]*"specialty"[\s\S]*"deckplans"/.test(shipCssSrc),
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
assert(/\.ship-deck-copy\s*\{[\s\S]*display:\s*grid/.test(shipCssSrc), "deck plans stack as column grid");

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

/* Mobile + iframe embed fixes (2026-08-09) */
assert(
  /Portal mobile \+ iframe embed fixes/.test(cssSrc),
  "planner.css includes portal mobile + iframe fix block"
);
assert(
  /html\.is-embedded \.dashboard-hero[\s\S]*width: 100% !important/.test(cssSrc),
  "embedded hero uses 100% width instead of 100vw bleed"
);
assert(
  /@media \(max-width: 820px\)[\s\S]*\.dashboard-countdown-panel[\s\S]*position: relative !important/.test(cssSrc),
  "mobile hero stacks countdown in document flow"
);
assert(
  /@media \(max-width: 760px\)[\s\S]*\.dashboard-snapshot-row[\s\S]*grid-template-columns: minmax\(0, 1fr\)/.test(cssSrc),
  "mobile snapshot rows stack label above value"
);
assert(
  /\.dashboard-snapshot-traveller-name[\s\S]*white-space: normal !important/.test(cssSrc),
  "traveller names wrap on mobile"
);
assert(
  /Portal mobile — prevent YES\/No pills/.test(shipCssSrc),
  "ship presentation includes YES pill overlap fix"
);
assert(
  /\.ship-glance-label[\s\S]*min-width: 0/.test(shipCssSrc),
  "ship glance labels can shrink below content width"
);
assert(
  /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\) !important/.test(cssSrc),
  "mobile countdown stays on one row"
);
assert(
  /html\.is-embedded[\s\S]*overflow-y:\s*auto !important/.test(cssSrc),
  "embedded iframe child document can scroll if parent height sync is stale"
);
assert(
  !/princess-controlled-catch-up-batch/.test(readFileSync(path.join(root, "index.html"), "utf8")),
  "index.html unchanged for batch module"
);

/* Module nav + packing quantity mobile fixes (2026-08-09c) */
assert(
  /@media \(max-width: 900px\)[\s\S]*Show all module tabs without horizontal scroll/.test(cssSrc),
  "mobile module nav shows all tabs in a grid instead of horizontal scroll"
);
assert(
  /\.planner-page-header \.planner-module-nav[\s\S]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/.test(cssSrc),
  "module nav uses 4-column grid on mobile"
);
assert(
  /@media \(max-width: 640px\)[\s\S]*\.packing-row[\s\S]*grid-template-columns: 22px 44px/.test(cssSrc),
  "packing row uses narrow quantity column on mobile"
);
assert(
  /\.packing-quantity-input[\s\S]*width: 40px/.test(cssSrc),
  "packing quantity input narrowed for mobile"
);
assert(
  /planner\.css\?v=20260822a/.test(readFileSync(path.join(root, "index.html"), "utf8")),
  "index.html cache-busts planner.css for embed scroll fallback"
);

/* Onboard at a Glance — 3 icons across on mobile (2026-08-09c) */
assert(
  /@media \(max-width: 760px\)[\s\S]*\.ship-glance-metrics,\s*\n\s*\.ship-glance-status[\s\S]*repeat\(3, minmax\(0, 1fr\)\)/.test(shipCssSrc),
  "onboard glance grids use 3 columns on mobile"
);
assert(
  /@media \(max-width: 520px\)[\s\S]*\.ship-glance-status[\s\S]*repeat\(3, minmax\(0, 1fr\)\)/.test(shipCssSrc),
  "narrow phones keep 3 glance columns instead of stacking to one"
);
assert(
  /ci-ship-presentation\.css\?v=20260809c/.test(readFileSync(path.join(root, "index.html"), "utf8")),
  "index.html cache-busts ship presentation CSS for glance grid fix"
);

console.log("test-client-portal-ui-fixes: ok");
