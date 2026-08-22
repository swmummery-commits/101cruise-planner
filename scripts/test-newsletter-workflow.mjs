#!/usr/bin/env node
/**
 * Compatibility and regression checks for newsletter-first admin workflow.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const adminJs = readFileSync(path.join(root, "js/admin.js"), "utf8");
const composerJs = readFileSync(path.join(root, "js/admin-newsletter-composer.js"), "utf8");
const mailchimpJs = readFileSync(path.join(root, "js/newsletter-mailchimp-export.js"), "utf8");
const publicFn = readFileSync(path.join(root, "netlify/functions/public-featured-cruise.js"), "utf8");
const migration = readFileSync(
  path.join(root, "supabase/migrations/20260803_newsletters_table.sql"),
  "utf8"
);
const auditSql = readFileSync(path.join(root, "scripts/audit-newsletter-date-conflicts.sql"), "utf8");

function assert(label, ok) {
  if (!ok) throw new Error(label);
  console.log("ok:", label);
}

const staticChecks = [
  ["migration creates newsletters table", /CREATE TABLE IF NOT EXISTS public\.newsletters/.test(migration)],
  ["migration adds newsletter_id FK", /featured_cruises\.newsletter_id/.test(migration)],
  ["migration blocks date conflicts", /conflicting newsletter_publication_date values/.test(migration)],
  ["migration uses single distinct date only", /COUNT\(DISTINCT fc\.newsletter_publication_date\)[\s\S]*= 1/.test(migration)],
  ["migration does not pick most common date", !/ORDER BY COUNT\(\*\) DESC/.test(migration)],
  ["audit SQL lists conflicting dates", /distinct_date_count/.test(auditSql)],
  ["cruisesForCurrentIssue ignores publication_status", (() => {
    const fn = composerJs.match(/function cruisesForCurrentIssue\(\)[\s\S]*?^  \}/m)?.[0] || "";
    return fn.length > 0 && !/publication_status/.test(fn);
  })()],
  ["saveNewsletter syncs linkage fields only", /const syncPayload = \{[\s\S]*newsletter_id[\s\S]*newsletter_number[\s\S]*newsletter_publication_date[\s\S]*\}/.test(composerJs)],
  ["saveNewsletter loads cruise ids from database", /\.eq\("newsletter_id", savedNewsletter\.id\)/.test(composerJs)],
  ["saveNewsletter guards duplicate batch", /if \(issueBusy \|\| routeMapSaveBusy\) return/.test(composerJs)],
  ["route map fetch has timeout", /ROUTE_MAP_FETCH_MS|AbortController/.test(composerJs)],
  ["slug manual edit guard", /if \(featuredSlugManuallyEdited\) return/.test(adminJs)],
  ["duplicate slug validation message", /already used by/.test(adminJs)],
  ["public API excludes archived", /publication_status=neq\.archived/.test(publicFn)],
  ["mailchimp validate ignores publicationStatus gate", !/publicationStatus !== "published"/.test(mailchimpJs)],
  ["Add Cruise buttons create a new cruise, not the existing-cruise picker", (() => {
    const handlers = [...composerJs.matchAll(/onclick="([^"]+)"[^>]*>\+ Add Cruise/g)].map((m) => m[1]);
    return (
      handlers.length >= 2 &&
      handlers.every((handler) => handler === "startNewFeaturedCruise()") &&
      !handlers.some((handler) => /openAddPicker|confirmAddPicker|addCruiseToIssue/.test(handler))
    );
  })()],
  ["new cruise inherits active newsletter_id from composer", (() => {
    const fn = adminJs.match(/async function startNewFeaturedCruise\(\)[\s\S]*?^async function /m)?.[0] || "";
    return (
      /NewsletterIssueComposer\?\.getSelectedIssue/.test(fn) &&
      /newsletter_id:\s*composerIssue\?\.id/.test(fn) &&
      /newsletter_number:\s*composerIssue\?\.number/.test(fn)
    );
  })()],
  ["saveFeaturedCruise persists composer newsletter_id", /const newsletterId = draft\.newsletter_id \|\| composerIssue\?\.id/.test(adminJs) && /newsletter_id:\s*newsletterId/.test(adminJs)],
  ["startNewFeaturedCruise does not reassign existing featured_cruises rows", (() => {
    const fn = adminJs.match(/async function startNewFeaturedCruise\(\)[\s\S]*?^async function /m)?.[0] || "";
    return fn.length > 0 && !/\.from\(["']featured_cruises["']\)/.test(fn) && !/openAddPicker|confirmAddPicker/.test(fn);
  })()],
  ["exportHtml uploads images to Mailchimp before copy/download", /NewsletterMailchimpAssets\.prepareExportedHtml/.test(composerJs)],
  ["exportHtml shows per-image progress", /Preparing newsletter images \$\{current\} of \$\{total\}/.test(composerJs) && /onProgress/.test(composerJs)],
  ["exportHtml fails closed when Mailchimp upload fails", /if \(!prepared\.ok\)/.test(composerJs) && /copyHostedHtml|copyPreparedHtml/.test(composerJs)],
  ["exportHtml does not copy unhosted compose HTML", !/clipboard\.writeText\(result\.html/.test(composerJs)],
  ["exportHtml recovers when the browser blocks clipboard after image prepare", /clipboard_blocked|blocked clipboard access/.test(composerJs)],
  ["Copy buttons do not trigger a file download", (() => {
    const copyFn = composerJs.match(/async function copyPreparedHtml[\s\S]*?^  }/m)?.[0] || "";
    return (
      copyFn.length > 0 &&
      !/downloadHtmlFile/.test(copyFn) &&
      !/HTML was downloaded instead/.test(composerJs) &&
      !/copyOrFallbackDownload/.test(composerJs)
    );
  })()]
];

let failed = 0;
for (const [label, ok] of staticChecks) {
  try {
    assert(label, ok);
  } catch (error) {
    console.error("FAIL:", error.message);
    failed += 1;
  }
}

const sandbox = {
  console,
  URL,
  URLSearchParams,
  Intl,
  Number,
  String,
  Boolean,
  Array,
  Object,
  Math,
  JSON,
  RegExp,
  Error,
  module: { exports: {} },
  exports: {}
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
const context = vm.createContext(sandbox);

function load(rel) {
  const code = readFileSync(path.join(root, rel), "utf8");
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  vm.runInContext(code, context, { filename: rel });
}

try {
  load("js/newsletter-typography.js");
  load("js/newsletter-cruise-shared.js");
  load("js/newsletter-mailchimp-export.js");
  const Export = sandbox.NewsletterMailchimpExport;
  const Shared = sandbox.NewsletterCruiseShared;

  const pricingRows = [
    {
      room_label: "Inside",
      brochure_price: 2000,
      cruise_101_price: 1200,
      airline_price: 900,
      display_order: 1
    }
  ];

  function miniModel(extras = {}) {
    return {
      destinationStrip: "SYDNEY TO SYDNEY",
      headline: "Test Cruise",
      heroImageUrl: "https://example.supabase.co/storage/v1/object/public/cruise-media/hero.jpg",
      heroImageAlt: "Hero",
      datesLine: "MON JAN 1 TO MON JAN 8, 2027",
      nightsShipLine: "7 NIGHTS | LINE SHIP",
      portsJoined: "Sydney | Noumea",
      description: "Editorial",
      descriptionParagraphs: ["Editorial"],
      publicSlug: "pacific-escape",
      routeMapUrl: "https://example.supabase.co/storage/v1/object/public/cruise-media/map.jpg",
      pricingModules: Shared.buildPricingModules(pricingRows, 7, { outputMode: "general" }),
      inclusionItems: [{ key: "wifi", shortLabel: "ALL WIFI", label: "Wi-Fi" }],
      otherInformation: "",
      disclaimerText: "Disclaimer",
      nights: 7,
      outputMode: "general",
      ...extras
    };
  }

  const draftBlank = Export.generateFromModel(
    miniModel({ publicSlug: "", landingPageUrl: "" }),
    { outputMode: "general", templateKey: "classic-editorial", pricingRows, publicSlug: "" }
  );
  assert("draft blank slug exports newsletter HTML", draftBlank.ok);
  assert("draft blank slug has no EXPLORE MORE", !/EXPLORE MORE/i.test(draftBlank.html));

  const withSlug = Export.generateFromModel(miniModel(), {
    outputMode: "general",
    templateKey: "classic-editorial",
    pricingRows,
    publicSlug: "pacific-escape"
  });
  assert("slugged cruise exports with CTA", withSlug.ok);
  assert(
    "slugged cruise includes public URL",
    withSlug.html.includes("https://www.101cruise.com.au/cruise?slug=pacific-escape")
  );

  const cleared = Export.generateFromModel(
    miniModel({ publicSlug: "" }),
    { outputMode: "general", templateKey: "classic-editorial", pricingRows, publicSlug: "" }
  );
  assert("cleared slug removes CTA", cleared.ok && !/EXPLORE MORE/i.test(cleared.html));
} catch (error) {
  console.error("FAIL: runtime mailchimp checks —", error.message);
  failed += 1;
}

try {
  const localStore = {};
  const newsletters = [
    { id: "nl-79", newsletter_number: 79, newsletter_date: "2026-08-13", design_template: "green-price-cards" },
    { id: "nl-78", newsletter_number: 78, newsletter_date: "2026-08-06", design_template: "green-price-cards" },
    { id: "nl-77", newsletter_number: 77, newsletter_date: "2026-07-30", design_template: "green-price-cards" }
  ];
  const cruise77 = {
    id: "cruise-77",
    headline: "Mediterranean from Newsletter 77",
    newsletter_id: "nl-77",
    newsletter_number: 77,
    newsletter_publication_date: "2026-07-30",
    display_order: 1,
    publication_status: "published"
  };
  const cruise78 = {
    id: "cruise-78",
    headline: "Alaska from Newsletter 78",
    newsletter_id: "nl-78",
    newsletter_number: 78,
    newsletter_publication_date: "2026-08-06",
    display_order: 1,
    publication_status: "published"
  };
  const snapshot77 = { ...cruise77 };
  const snapshot78 = { ...cruise78 };

  const composerSandbox = {
    console,
    URL,
    URLSearchParams,
    Intl,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Math,
    JSON,
    RegExp,
    Error,
    localStorage: {
      getItem(key) {
        return Object.prototype.hasOwnProperty.call(localStore, key) ? localStore[key] : null;
      },
      setItem(key, value) {
        localStore[key] = String(value);
      },
      removeItem(key) {
        delete localStore[key];
      }
    },
    featuredCruises: [cruise77, cruise78],
    featuredNewsletterDefaults: { newsletter_number: 79, newsletter_publication_date: "2026-08-13" },
    renderAdmin() {},
    supabaseClient: {
      from(table) {
        const result = { data: table === "newsletters" ? newsletters : [], error: null };
        const chain = {
          select() {
            return chain;
          },
          order() {
            return chain;
          },
          eq() {
            return chain;
          },
          in() {
            return chain;
          },
          is() {
            return chain;
          },
          then(resolve, reject) {
            return Promise.resolve(result).then(resolve, reject);
          }
        };
        return chain;
      }
    },
    module: { exports: {} },
    exports: {}
  };
  composerSandbox.globalThis = composerSandbox;
  composerSandbox.window = composerSandbox;
  const composerContext = vm.createContext(composerSandbox);
  vm.runInContext(composerJs, composerContext, { filename: "js/admin-newsletter-composer.js" });

  const Composer = composerSandbox.NewsletterIssueComposer;
  await Composer.loadNewslettersFromDb();
  await Composer.openNewsletterById("nl-79");

  const selected = Composer.getSelectedIssue();
  assert("active newsletter 79 is selected for inheritance", selected.id === "nl-79" && Number(selected.number) === 79);

  const htmlBefore = Composer.render();
  const addCruiseHandlers = [...htmlBefore.matchAll(/onclick="([^"]+)"[^>]*>\+ Add Cruise/g)].map((m) => m[1]);
  assert(
    "Add Cruise on Newsletter 79 opens new-cruise creation",
    addCruiseHandlers.length >= 2 && addCruiseHandlers.every((handler) => handler === "startNewFeaturedCruise()")
  );
  assert(
    "Add Cruise does not open the existing-cruise picker",
    !htmlBefore.includes("openAddPicker") &&
      !htmlBefore.includes("Select cruises not already in Newsletter") &&
      !htmlBefore.includes("currently Newsletter 77") &&
      !htmlBefore.includes("currently Newsletter 78")
  );
  assert(
    "Newsletter 79 starts with no assigned cruises",
    htmlBefore.includes("No cruises in this newsletter yet") &&
      !htmlBefore.includes("Mediterranean from Newsletter 77") &&
      !htmlBefore.includes("Alaska from Newsletter 78")
  );

  const created = {
    id: "cruise-79-new",
    headline: "New Newsletter 79 Test Cruise",
    newsletter_id: selected.id,
    newsletter_number: selected.number,
    newsletter_publication_date: selected.date,
    display_order: 1,
    publication_status: "draft"
  };
  composerSandbox.featuredCruises.push(created);

  const htmlAfter = Composer.render();
  assert(
    "saved cruise appears in Newsletter 79 list",
    htmlAfter.includes("New Newsletter 79 Test Cruise") && htmlAfter.includes('data-cruise-id="cruise-79-new"')
  );
  assert(
    "previous newsletter cruises were not reassigned",
    cruise77.newsletter_id === snapshot77.newsletter_id &&
      cruise77.newsletter_number === snapshot77.newsletter_number &&
      cruise78.newsletter_id === snapshot78.newsletter_id &&
      cruise78.newsletter_number === snapshot78.newsletter_number &&
      !htmlAfter.includes("Mediterranean from Newsletter 77") &&
      !htmlAfter.includes("Alaska from Newsletter 78")
  );
  assert(
    "created cruise payload is associated with Newsletter 79",
    created.newsletter_id === "nl-79" && Number(created.newsletter_number) === 79
  );
} catch (error) {
  console.error("FAIL: newsletter Add Cruise workflow —", error.message);
  failed += 1;
}

if (failed) {
  process.exitCode = 1;
  console.error(`\n${failed} check(s) failed.`);
} else {
  console.log(`\nAll static and runtime checks passed (${staticChecks.length} static).`);
}
