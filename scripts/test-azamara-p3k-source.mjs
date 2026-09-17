#!/usr/bin/env node
/**
 * P3K Azamara source repair unit tests (mocked — no production writes, no Friday lease).
 * Run: node scripts/test-azamara-p3k-source.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const adapter = require(path.join(root, "netlify/functions/lib/azamara-discovery-adapter"));
const source = require(path.join(root, "netlify/functions/lib/azamara-discovery-source"));
const absence = require(path.join(root, "netlify/functions/lib/azamara-source-absence"));
const weekly = require(path.join(root, "netlify/functions/lib/azamara-weekly-maintenance"));
const schedule = require(path.join(root, "netlify/functions/lib/weekly-maintenance-schedule-control"));

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  passed += 1;
}

const {
  parsePackageFromUrl,
  extractAzamaraPackagesFromSitemapXml,
  detectAzamaraSourceCollapse,
  simulateAzamaraDiscovery,
  mapLimit,
  AZAMARA_DETAIL_CONCURRENCY,
  AZAMARA_HTML_DEADLINE_MS
} = adapter;
const { azamaraStaleSourceGate, extractAzamaraGtmFromHtml } = source;

assert(AZAMARA_DETAIL_CONCURRENCY >= 4 && AZAMARA_DETAIL_CONCURRENCY <= 8, "detail concurrency is conservative 4–8");
assert(AZAMARA_HTML_DEADLINE_MS === 720000, "html deadline remains 720s");

const adapterSrc = fs.readFileSync(path.join(root, "netlify/functions/lib/azamara-discovery-adapter.js"), "utf8");
assert(adapterSrc.includes('redirect: "follow"'), "production fetch follows redirects");
assert(adapterSrc.includes('redirect: "manual"'), "sitemap fetch uses hop-limited manual redirects");
assert(adapterSrc.includes("https://www.azamara.com/sitemap"), "/sitemap fallback candidate present");
assert(!adapterSrc.includes("https.get("), "does not regress to Node https.get 302 bug");

const weeklySrc = fs.readFileSync(path.join(root, "netlify/functions/lib/azamara-weekly-maintenance.js"), "utf8");
assert(!weeklySrc.includes("scheduledWeeklyDispatchKey"), "weekly runner does not claim scheduled lease");
const cronSrc = fs.readFileSync(path.join(root, "netlify/functions/azamara-weekly-maintenance-cron.js"), "utf8");
assert(cronSrc.includes("handleLeasedWeeklyCron"), "scheduled lease only via cron launcher");
assert(
  schedule.scheduledWeeklyDispatchKey("azamara", new Date("2026-09-17T16:00:00+08:00")) === "azamara:2026-W38:scheduled",
  "Friday W38 scheduled key unchanged"
);
assert(
  schedule.weeklyNamespacedDispatchKey("azamara", "p3k-incident-1", "preflight") ===
    "weekly:azamara:p3k-incident-1:preflight",
  "preflight uses unique dispatch namespace"
);
assert(
  schedule.weeklyNamespacedDispatchKey("azamara", "p3k-incident-1", "incident") ===
    "weekly:azamara:p3k-incident-1:incident",
  "incident namespace distinct from scheduled"
);

const short = parsePackageFromUrl("https://www.azamara.com/cruises/jr261019-010");
assert(short.fullCode === "JR261019-010", "short package code parsed");
assert(short.url.endsWith("/cruises/jr261019-010"), "short url kept as-is");

const slug = parsePackageFromUrl(
  "https://www.azamara.com/cruises/jr261019-010-canada-new-england-cruise-quebec-city-halifax-portland"
);
assert(slug.fullCode === "JR261019-010", "slug package code parsed");
assert(/canada-new-england/.test(slug.url), "canonical url keeps official slug");
assert(slug.url.length > short.url.length, "slug url is richer than reconstructed short url");

const localeSlug = parsePackageFromUrl(
  "https://www.azamara.com/au/cruises/on270515-010-mediterranean-cruise"
);
assert(localeSlug.fullCode === "ON270515-010", "locale-prefixed slug parsed");

const ct = parsePackageFromUrl(
  "https://www.azamara.com/cruises/pr270705-014-cta01-alaska-explorer-cruisetour-denali"
);
assert(ct.isCruisetour === true, "cruisetour suffix classified");
assert(ct.fullCode === "PR270705-014-CTA01", "cruisetour full code preserved");

const xml = `<?xml version="1.0" encoding="utf-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://www.azamara.com/cruises/jr261019-010</loc></url>
  <url><loc>https://www.azamara.com/cruises/jr261019-010-canada-new-england-cruise-quebec-city</loc></url>
  <url><loc>https://www.azamara.com/cruises/qs280101-012-south-america-cruise</loc></url>
  <url><loc>https://www.azamara.com/about</loc></url>
</urlset>`;
const extracted = extractAzamaraPackagesFromSitemapXml(xml);
assert(extracted.urlset === true, "urlset detected");
assert(extracted.sitemapindex === false, "not sitemapindex");
assert(extracted.locs === 3, "cruise-like loc count excludes /about");
assert(extracted.raw_loc_tags === 4, "raw loc tags include non-cruise URLs");
assert(extracted.packages.length === 2, "unique package codes");
const jr = extracted.packages.find((p) => p.fullCode === "JR261019-010");
assert(/canada-new-england/.test(jr.url), "dedupe prefers longer official slug over short /cruises/CODE");

const homepageHtml =
  '<html><title>Azamara Cruises | Award-Winning Small Ship Cruise Line</title><body>Home</body></html>';
const liveHtml =
  '<html><title>Canada &amp; New England</title><div data-gtm-duration="10-NIGHT CRUISE" data-gtm-package-code="JR261019-010" data-gtm-ship-name="Azamara Journey" data-gtm-destination="CANADA" data-gtm-cruise-name="CANADA &amp; NEW ENGLAND"></div></html>';

assert(
  azamaraStaleSourceGate({
    html: homepageHtml,
    title: "Azamara Cruises | Award-Winning Small Ship Cruise Line",
    url: "https://www.azamara.com/cruises/jr261019-010",
    finalUrl: "https://www.azamara.com/home"
  })?.diagnostics?.azamara_source_status === "detail_redirected_to_homepage",
  "stale gate true-positive: short URL landed on /home"
);
assert(
  !azamaraStaleSourceGate({
    html: liveHtml,
    title: "Canada & New England",
    url: "https://www.azamara.com/cruises/jr261019-010-canada-new-england-cruise-quebec-city",
    finalUrl: "https://www.azamara.com/cruises/jr261019-010-canada-new-england-cruise-quebec-city"
  }),
  "stale gate false-positive regression: valid GTM cruise page is not stale"
);
assert(extractAzamaraGtmFromHtml(liveHtml).nights === 10, "GTM duration parsed from data-gtm-duration");
assert(extractAzamaraGtmFromHtml(liveHtml).package_code === "JR261019-010", "GTM package_code parsed");

const ordered = await mapLimit([30, 5, 15, 1], 3, async (ms, index) => {
  await new Promise((r) => setTimeout(r, ms));
  return `i${index}:${ms}`;
});
assert(ordered.join(",") === "i0:30,i1:5,i2:15,i3:1", "mapLimit preserves input order");

const line = { id: source.AZAMARA_LINE_ID, name: "Azamara", slug: "azamara" };
const ships = [
  { id: "ship-jr", name: "Journey", cruise_line_id: line.id },
  { id: "ship-on", name: "Onward", cruise_line_id: line.id },
  { id: "ship-pr", name: "Pursuit", cruise_line_id: line.id },
  { id: "ship-qs", name: "Quest", cruise_line_id: line.id }
];

function sitemapWith(packages) {
  const locs = packages
    .map((p) => `<url><loc>${p}</loc></url>`)
    .join("\n");
  return `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs}</urlset>`;
}

const slugA = "https://www.azamara.com/cruises/jr261019-010-canada-new-england-cruise";
const slugB = "https://www.azamara.com/cruises/pr270705-014-japan-intensive";
const slugC = "https://www.azamara.com/cruises/on270101-007-mediterranean";
const slugD = "https://www.azamara.com/cruises/qs270515-012-south-america";
const ctUrl = "https://www.azamara.com/cruises/pr270705-014-cta01-alaska-cruisetour";

async function runSim({ pages, sitemapStatus = 200, sitemapUrlHasPackages = true, htmlDeadlineMs = 60000, detailConcurrency = 4 }) {
  const sitemapBody = sitemapWith(
    sitemapUrlHasPackages ? [slugA, slugB, slugC, slugD, ctUrl, "https://www.azamara.com/cruises/jr261019-010"] : []
  );
  let sitemapXmlHits = 0;
  let sitemapBareHits = 0;
  const fetchImpl = async (url, _max, _accept) => {
    if (String(url).includes("sitemap.xml")) {
      sitemapXmlHits += 1;
      if (sitemapStatus !== 200) return { status: sitemapStatus, text: "forbidden", final_url: url, content_type: "text/html" };
      return { status: 200, text: sitemapBody, final_url: "https://www.azamara.com/sitemap", content_type: "application/xml" };
    }
    if (String(url).endsWith("/sitemap")) {
      sitemapBareHits += 1;
      return { status: 200, text: sitemapBody, final_url: "https://www.azamara.com/sitemap", content_type: "application/xml" };
    }
    const page = pages[url] || pages.default || { status: 200, text: homepageHtml, final_url: "https://www.azamara.com/home" };
    if (page.delay) await new Promise((r) => setTimeout(r, page.delay));
    if (page.error) throw new Error(page.error);
    return {
      status: page.status || 200,
      text: page.text,
      final_url: page.final_url || url,
      content_type: "text/html;charset=UTF-8"
    };
  };
  const simulation = await simulateAzamaraDiscovery({
    cruiseLine: line,
    ships,
    destinations: [{ id: "dest-canada", name: "Canada & New England", slug: "canada-new-england", status: "active" }],
    today: "2026-09-17",
    fetchImpl,
    htmlDeadlineMs,
    detailConcurrency
  });
  return { simulation, sitemapXmlHits, sitemapBareHits };
}

const fallback = await runSim({
  pages: {},
  sitemapStatus: 403,
  sitemapUrlHasPackages: true
});
assert(fallback.sitemapXmlHits >= 1, "tries /sitemap.xml first");
assert(fallback.sitemapBareHits >= 1, "/sitemap fallback used after xml failure");
assert(fallback.simulation.fetch_result.ok === true, "sitemap fallback succeeds");
assert(fallback.simulation.fetch_result.sitemap_packages >= 4, "packages extracted from /sitemap fallback");

const homepageCollapse = await runSim({
  pages: {
    default: { status: 200, text: homepageHtml, final_url: "https://www.azamara.com/home" }
  }
});
assert(homepageCollapse.simulation.source_eligible_official_ids.length === 0, "homepage bodies yield zero eligible");
assert(homepageCollapse.simulation.outcome_counts.source_stale_or_unavailable > 0, "stale gate fires on homepage redirect");
const collapse = detectAzamaraSourceCollapse({
  simulation: homepageCollapse.simulation,
  productionOfficial: 436
});
assert(collapse.collapsed === true, "production 436 + eligible 0 collapses");
assert(collapse.category === "PARSER_REGRESSION" || collapse.category === "CATASTROPHIC_COLLAPSE", collapse.category);

const timeoutSim = await runSim({
  pages: {
    default: { status: 200, text: liveHtml, delay: 40 }
  },
  htmlDeadlineMs: 5,
  detailConcurrency: 2
});
assert(timeoutSim.simulation.fetch_result.source_timeout === true, "deadline produces source_timeout");
assert(timeoutSim.simulation.fetch_result.pagination.exhausted === false, "timeout snapshot is not exhausted");
assert(absence.isAzamaraSourceSnapshotComplete(timeoutSim.simulation) === false, "timeout snapshot is incomplete");
assert(
  timeoutSim.simulation.fetch_result.stage_accounting.reconciled === true,
  "timeout stage accounting reconciles"
);

const accounting = await runSim({
  pages: {
    [slugA]: { status: 200, text: liveHtml, final_url: slugA },
    [slugB]: { status: 200, text: homepageHtml, final_url: "https://www.azamara.com/home" },
    [slugC]: { status: 404, text: "not found", final_url: slugC },
    [slugD]: {
      status: 200,
      text: '<html><title>South America</title><div data-gtm-package-code="QS270515-012" data-gtm-ship-name="Azamara Quest"></div></html>',
      final_url: slugD
    }
  }
});
const oc = accounting.simulation.outcome_counts;
const fr = accounting.simulation.fetch_result;
assert(fr.stage_accounting.reconciled === true, "full-stage accounting exact");
assert(oc.policy_excluded_cruisetour >= 1, "cruisetours excluded");
assert(oc.source_stale_or_unavailable >= 1, "stale counted");
assert(oc.http_source_failure >= 1, "http failure counted");
assert(oc.missing_gtm_duration >= 1, "missing GTM duration counted");
assert(
  oc.recognised_existing_unchanged +
    oc.recognised_existing_changed +
    oc.new_candidate +
    oc.policy_excluded_cruisetour +
    oc.source_stale_or_unavailable +
    oc.http_source_failure +
    oc.validation_failed +
    oc.dest_quality_excluded +
    oc.matcher_picker_mismatch +
    oc.source_timeout_unprocessed ===
    fr.eligible_urls,
  "terminal dispositions sum to eligible URLs"
);

assert(
  weekly.buildAzamaraWeeklySummary({
    runId: "azamara:p3k-unit",
    today: "2026-09-17",
    startedAt: Date.now(),
    performWrites: false,
    manifest: {
      source_counts: { source_eligible: 0 },
      production_official: 436,
      recognised_eligible: 0,
      outstanding_eligible: 0,
      inserts: [{ official_sailing_id: "JR261019-010" }],
      updates: [],
      identity_review: [],
      cutoff_hides: [],
      source_absence_hides: [],
      legacy_ignored: 0
    },
    applyResult: { stats: { inserted: 0, updated: 0, failed: 0 } }
  }).writes_performed.inserted === 0,
  "collapse path does not invent writes"
);

console.log(`test-azamara-p3k-source — ${passed} assertions passed`);
