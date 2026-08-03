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
  ["mailchimp validate ignores publicationStatus gate", !/publicationStatus !== "published"/.test(mailchimpJs)]
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

if (failed) {
  process.exitCode = 1;
  console.error(`\n${failed} check(s) failed.`);
} else {
  console.log(`\nAll static and runtime checks passed (${staticChecks.length} static).`);
}
