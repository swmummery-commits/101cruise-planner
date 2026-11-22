#!/usr/bin/env node
/**
 * Client Reviews section: omission rules, photo order, and Mailchimp HTML.
 * Run: node scripts/test-newsletter-client-reviews.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assert(label, ok) {
  if (!ok) throw new Error(label);
  console.log("ok:", label);
}

const PHOTO_A = "https://example.supabase.co/storage/v1/object/public/cruise-media/reviews/harbour.jpg";
const PHOTO_B = "https://example.supabase.co/storage/v1/object/public/cruise-media/reviews/deck.jpg";
const PHOTO_C = "https://example.supabase.co/storage/v1/object/public/cruise-media/reviews/dining.jpg";

function photo(id, url) {
  return { id, media_id: id, url, alt: id, width: 800, height: 600, file_name: `${id}.jpg` };
}

const sandbox = {
  console,
  URL,
  URLSearchParams,
  Number,
  String,
  Boolean,
  Array,
  Object,
  Math,
  JSON,
  RegExp,
  Error,
  Map,
  Set,
  document: {
    getElementById() {
      return null;
    },
    createElement() {
      return { id: "", textContent: "" };
    },
    head: { appendChild() {} }
  },
  NewsletterIssueComposer: {
    __clientReviewsApplied: false,
    render() {
      return '<div class="newsletter-workspace-fields"></div><section class="newsletter-editorial-editor"></section>';
    },
    saveNewsletter() {
      return Promise.resolve("saved-rest");
    },
    openNewsletterById() {
      return Promise.resolve("opened");
    },
    selectIssueNumber() {
      return Promise.resolve("selected");
    },
    startNewNewsletter() {},
    preview() {
      return Promise.resolve("previewed");
    },
    exportHtml() {
      return Promise.resolve("exported");
    },
    printRecord() {
      return Promise.resolve("printed");
    },
    getActiveNewsletter() {
      return { id: "issue-1", newsletter_number: 80 };
    }
  }
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
const context = vm.createContext(sandbox);

function load(rel) {
  vm.runInContext(readFileSync(path.join(root, rel), "utf8"), context, { filename: rel });
}

load("js/newsletter-client-reviews.js");
load("js/newsletter-mailchimp-assets.js");
load("js/admin-newsletter-client-reviews.js");

const Reviews = sandbox.NewsletterClientReviews;
const Assets = sandbox.NewsletterMailchimpAssets;
const Admin = sandbox.NewsletterClientReviewsAdmin;

let failed = 0;
function check(label, ok) {
  try {
    assert(label, ok);
  } catch (error) {
    failed += 1;
    console.error("FAIL:", error.message);
  }
}

const blank = Reviews.renderHtml({
  eyebrow: "From our clients",
  headline: "A week to remember",
  text: "   \n\t  ",
  photos: [photo("a", PHOTO_A)]
});
check("whitespace review omits the whole section", blank === "");
check("title and photos alone do not render a section", Reviews.hasText({ eyebrow: "Reviews", photos: [photo("a", PHOTO_A)] }) === false);

const textOnly = Reviews.renderHtml({
  eyebrow: "From our clients",
  headline: "A week to remember",
  text: "The ship felt calm from the first evening.\n\nWe would book again.",
  photos: []
});
check("review without photos renders", textOnly.includes("data-cr101-client-reviews"));
check("review without photos has no photo column", !textOnly.includes('class="cr101-review-col cr101-review-photos"'));
check("review without photos uses the full text width", textOnly.includes('class="cr101-review-col cr101-review-copy"') && textOnly.includes("width:100%"));
check("eyebrow uses the newsletter eyebrow style", textOnly.includes("letter-spacing:3px") && textOnly.includes("text-transform:uppercase") && textOnly.includes("font-size:14px;font-weight:400") && textOnly.includes("color:#545454;text-align:center"));
check("eyebrow is its own full-width row", textOnly.indexOf("letter-spacing:3px") < textOnly.indexOf('class="cr101-review-col cr101-review-copy"') && textOnly.includes('colspan="1"'));
check("headline sits above the review text", textOnly.indexOf("A week to remember") < textOnly.indexOf("The ship felt calm"));
check("review body is 13px and the headline stays 22px", textOnly.includes("font-size:13px;line-height:1.65") && textOnly.includes("font-size:22px;font-weight:700"));
check("blank lines become paragraphs", (textOnly.match(/<p /g) || []).length === 2);
check("single line breaks stay inside a paragraph", Reviews.renderHtml({ text: "First line\nSecond line" }).includes("<br>"));

const several = Reviews.renderHtml({
  eyebrow: "Client reviews",
  headline: "Three favourite moments",
  text: "Harbour morning.\n\nQuiet decks.\n\nA long dinner.",
  photos: [photo("a", PHOTO_A), photo("b", PHOTO_B), photo("c", PHOTO_C)]
});
check("several photos render in saved order", several.indexOf(PHOTO_A) < several.indexOf(PHOTO_B) && several.indexOf(PHOTO_B) < several.indexOf(PHOTO_C));
check("photos sit in the left third", several.includes("cr101-review-photos") && several.includes("width:33%") && several.indexOf("cr101-review-photos") < several.indexOf("cr101-review-copy"));
check("review photos have square corners", !several.includes("border-radius"));
check("eyebrow spans the photo and text columns", several.includes('colspan="2"'));
check("text fills the remaining width beside the photos", several.includes("cr101-review-copy") && !several.includes("width:67%") && several.includes("padding-left:24px") && several.includes("padding-left: 0 !important"));
check("narrow screens stack the columns", several.includes("max-width: 620px") && several.includes(".cr101-review-col") && several.includes("display: block !important"));
check("export html is not treated as opening copy", several.includes("cr101-client-reviews") && !several.includes("cr101-issue-opening"));
check("export html has no script or event handlers", !/<script/i.test(several) && !/\son[a-z]+\s*=/i.test(several));

const collected = Assets.collectSupabaseImageUrls(several);
check("exported photos are picked up by the email image host", collected.length === 3 && collected[0] === PHOTO_A && collected[2] === PHOTO_C);

const unsafe = Reviews.normalize({
  text: "<script>alert(1)</script>",
  photos: [{ id: "bad", url: "javascript:alert(1)" }, photo("a", PHOTO_A)]
});
const escaped = Reviews.renderHtml(unsafe);
check("review text is escaped", escaped.includes("&lt;script&gt;") && !escaped.includes("<script>alert"));
check("non-http photo addresses are dropped", !escaped.includes("javascript:") && escaped.includes(PHOTO_A));

const reordered = Reviews.orderPhotos(
  [photo("a", PHOTO_A), photo("b", PHOTO_B), photo("c", PHOTO_C)],
  ["c", "a", "b"]
);
check("photo reorder follows the dropped order", reordered.map((item) => item.id).join(",") === "c,a,b");
const removed = reordered.filter((item) => item.id !== "a");
check("removing one photo keeps the others in order", removed.map((item) => item.id).join(",") === "c,b");

const roundTrip = Reviews.normalize({
  client_review_eyebrow: "  Eyebrow  ",
  client_review_headline: " Headline ",
  client_review_text: " Saved review \n\n Second paragraph ",
  client_review_photos: [photo("b", PHOTO_B), photo("a", PHOTO_A)]
});
check("saved fields restore eyebrow, headline, text and photo order", roundTrip.eyebrow === "Eyebrow" && roundTrip.headline === "Headline" && roundTrip.photos.map((item) => item.id).join(",") === "b,a");
check("paragraph breaks survive normalise", roundTrip.text.includes("\n\n"));

const issueHtml = "<table class=\"cr101-issue\"><tr><td>Specials</td></tr></table>";
const appended = Reviews.applyToExportResult(
  {
    ok: true,
    html: issueHtml,
    previewHtml: `<div class="cr101-admin-preview">${issueHtml}</div>`
  },
  { text: "A real review.", photos: [photo("a", PHOTO_A)] }
);
check("preview and export append the section after the specials", appended.html.startsWith(issueHtml) && appended.html.includes("cr101-client-reviews"));
check("preview html receives the same section", appended.previewHtml.includes("cr101-admin-preview") && appended.previewHtml.includes("A real review."));
const cleared = Reviews.applyToExportResult(
  { ok: true, html: issueHtml, previewHtml: `<div>${issueHtml}</div>` },
  { text: "   ", eyebrow: "Still here", photos: [photo("a", PHOTO_A)] }
);
check("clearing review text removes the section from export", cleared.html === issueHtml && !cleared.previewHtml.includes("cr101-client-reviews"));

const editor = Admin.renderEditorSection(
  {
    eyebrow: "From our clients",
    headline: "A quiet ship",
    text: "We loved the week.",
    photos: [photo("a", PHOTO_A), photo("b", PHOTO_B)]
  },
  false
);
check("editor has eyebrow, headline, review text and a multi-file picker", editor.includes("newsletterReviewEyebrow") && editor.includes("newsletterReviewHeadline") && editor.includes("newsletterReviewText") && editor.includes('type="file"') && editor.includes("multiple"));
check("editor can add more photos and remove one", editor.includes("Add more photos") && editor.includes("Remove") && editor.includes("Drop more photos"));
check("editor lists photos in stored order", editor.indexOf("Photo 1") < editor.indexOf("Photo 2") && editor.indexOf(PHOTO_A) < editor.indexOf(PHOTO_B));
check("editor drop zone accepts files", editor.includes("onFileDrop") && editor.includes("allowFileDrop"));

const composerJs = readFileSync(path.join(root, "js/admin-newsletter-composer.js"), "utf8");
const adminHtml = readFileSync(path.join(root, "admin.html"), "utf8");
const migration = readFileSync(path.join(root, "supabase/migrations/20261122_newsletter_client_reviews.sql"), "utf8");
const toolbarJs = readFileSync(path.join(root, "js/admin-newsletter-toolbar.js"), "utf8");
check("export cache includes the review stamp", /NewsletterClientReviewsAdmin\?\.exportStamp/.test(composerJs));
check("hosted html is not reused after the review changes", /hostedExport\.reviewStamp/.test(composerJs));
check("admin page loads the client review scripts", adminHtml.includes("js/newsletter-client-reviews.js") && adminHtml.includes("js/admin-newsletter-client-reviews.js"));
check("migration only adds review columns", /ADD COLUMN IF NOT EXISTS client_review_text/.test(migration) && !/DROP TABLE|DELETE FROM|UPDATE public\.newsletters SET/i.test(migration));
check("opening-copy strip does not target client reviews", toolbarJs.includes("cr101-issue-opening") && !toolbarJs.includes("cr101-client-reviews"));

const payload = Admin.payloadFor({
  eyebrow: " Label ",
  headline: " Heading ",
  text: " Body \n\n More ",
  photos: [photo("c", PHOTO_C), { id: "drop", url: "/local/secret.jpg" }]
});
check("save payload keeps text and drops unsafe photo urls", payload.client_review_text === "Body \n\n More" && payload.client_review_photos.length === 1 && payload.client_review_photos[0].id === "c");

if (failed) {
  console.error(`${failed} check${failed === 1 ? "" : "s"} failed`);
  process.exit(1);
}
console.log("client reviews checks passed");
