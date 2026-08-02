#!/usr/bin/env node
/**
 * Audit and hide discovered_cruises + ignore review items that are not bookable sailings.
 *
 *   node scripts/purge-non-sailing-discovery-sources.mjs --dry-run
 *   node scripts/purge-non-sailing-discovery-sources.mjs --apply
 *
 * Requires .env SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (Original production only).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { classifyNonSailingSource } = require(
  path.join(root, "netlify/functions/lib/discovery-non-sailing-filter.js")
);

function parseArgs(argv) {
  const args = { dryRun: true, apply: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") args.dryRun = true;
    if (arg === "--apply") {
      args.apply = true;
      args.dryRun = false;
    }
  }
  return args;
}

function cruiseInput(row) {
  return {
    url: row.official_url || row.source_url,
    title: row.raw_extract?.title || row.itinerary,
    description: row.raw_extract?.description,
    ship_name_guess: row.raw_extract?.ship_name_guesses?.[0] || row.review_reason,
    ship_name_guesses: row.raw_extract?.ship_name_guesses || [],
    ship_id: row.ship_id,
    departure_date: row.departure_date,
    raw_extract: row.raw_extract
  };
}

function reviewInput(item) {
  const payload = item.payload || {};
  return {
    url: item.source_url || payload.official_url || payload.source_url,
    title: item.title || payload.title || payload.itinerary,
    description: item.detail || payload.description,
    ship_name_guess: payload.raw_ship_name || payload.ship_name_guess,
    ship_name_guesses: payload.ship_name_guesses || [],
    ship_id: payload.ship_id,
    departure_date: payload.departure_date,
    payload
  };
}

function summariseByReason(rows) {
  const counts = {};
  for (const row of rows) {
    counts[row.reason] = (counts[row.reason] || 0) + 1;
  }
  return counts;
}

async function main() {
  const args = parseArgs(process.argv);
  const supabase = createSupabaseRest(root);
  const projectUrl = process.env.SUPABASE_URL || "";
  if (/vkheexbapykcdfbqcach/i.test(projectUrl)) {
    throw new Error("REFUSED: DEV Supabase project detected");
  }

  const cruises = await supabase.get(
    "discovered_cruises?status=neq.hidden&select=id,status,official_url,source_url,itinerary,departure_date,ship_id,review_reason,raw_extract,cruise_line_id&order=discovered_at.desc&limit=5000"
  );
  const reviewItems = await supabase.get(
    "cruise_discovery_review_items?status=eq.pending&select=id,cruise_id,item_type,title,detail,source_url,payload&order=created_at.desc&limit=5000"
  );

  const cruiseHits = [];
  for (const row of cruises || []) {
    const verdict = classifyNonSailingSource(cruiseInput(row));
    if (verdict.rejected) {
      cruiseHits.push({
        id: row.id,
        status: row.status,
        url: row.official_url || row.source_url,
        title: row.raw_extract?.title || row.itinerary,
        reason: verdict.reason
      });
    }
  }

  const hiddenCruiseIds = new Set(cruiseHits.map((h) => h.id));
  const reviewHits = [];
  for (const item of reviewItems || []) {
    const verdict = classifyNonSailingSource(reviewInput(item));
    const linkedHidden = item.cruise_id && hiddenCruiseIds.has(item.cruise_id);
    if (verdict.rejected || linkedHidden) {
      reviewHits.push({
        id: item.id,
        cruise_id: item.cruise_id,
        item_type: item.item_type,
        url: item.source_url || item.payload?.official_url,
        title: item.title,
        reason: linkedHidden && !verdict.rejected ? "linked_hidden_cruise" : verdict.reason
      });
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    mode: args.apply ? "apply" : "dry-run",
    cruises_scanned: (cruises || []).length,
    cruises_to_hide: cruiseHits.length,
    review_items_scanned: (reviewItems || []).length,
    review_items_to_ignore: reviewHits.length,
    hide_reasons: summariseByReason(cruiseHits),
    ignore_reasons: summariseByReason(reviewHits),
    samples: {
      cruises: cruiseHits.slice(0, 25),
      review_items: reviewHits.slice(0, 25)
    }
  };

  const reportsDir = path.join(root, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportsDir, `non-sailing-purge-${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ ...report, cruises: cruiseHits, review_items: reviewHits }, null, 2));

  console.log(`Non-sailing discovery purge (${args.apply ? "APPLY" : "DRY-RUN"})`);
  console.log(`Report: ${reportPath}`);
  console.log(`Cruises scanned: ${report.cruises_scanned}`);
  console.log(`Cruises to hide: ${report.cruises_to_hide}`);
  console.log(`Review items to ignore: ${report.review_items_to_ignore}`);
  console.log("Hide reasons:", report.hide_reasons);
  console.log("Ignore reasons:", report.ignore_reasons);

  if (args.dryRun) {
    console.log("\nDry-run only. Re-run with --apply to hide cruises and ignore review items.");
    return;
  }

  let hidden = 0;
  for (const hit of cruiseHits) {
    await supabase.patch(`discovered_cruises?id=eq.${encodeURIComponent(hit.id)}`, {
      status: "hidden",
      review_reason: `non_sailing:${hit.reason}`,
      last_changed_at: new Date().toISOString()
    });
    hidden += 1;
  }

  let ignored = 0;
  for (const hit of reviewHits) {
    await supabase.patch(`cruise_discovery_review_items?id=eq.${encodeURIComponent(hit.id)}`, {
      status: "ignored",
      resolved_at: new Date().toISOString(),
      detail: hit.reason ? `Auto-ignored: ${hit.reason}` : undefined
    });
    ignored += 1;
  }

  console.log(`\nApplied: ${hidden} cruises hidden, ${ignored} review items ignored.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
