#!/usr/bin/env node
/**
 * Read-only classification audit of pending Discovery review queue.
 * Does not modify any records.
 *
 *   node scripts/audit-discovery-review-queue.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { classifyNonSailingSource, evaluateSailingEvidence } = require(
  path.join(root, "netlify/functions/lib/discovery-non-sailing-filter.js")
);

const CATEGORIES = {
  auto_resolvable: "Genuine cruise, automatically resolvable",
  human_review: "Genuine cruise, genuine ambiguity requiring human review",
  non_sailing: "Non-sailing page that should have been filtered",
  duplicate: "Duplicate of another sailing/finding",
  poor_extraction: "Poor extraction from an otherwise valid sailing page",
  transient_failure: "Temporary fetch/source failure",
  obsolete: "Obsolete or expired finding"
};

function classifyItem(item, cruiseById, allItems) {
  const payload = item.payload || {};
  const url = item.source_url || payload.official_url || payload.source_url || "";
  const title = item.title || payload.title || "";
  const detail = item.detail || "";

  if (/search failed|brave search|fetch_failed|timeout|blocked/i.test(`${title} ${detail}`)) {
    return { category: "transient_failure", cause: "search_or_fetch_failure", codePath: "discoverForCruiseLine search catch" };
  }

  const nonSailing = classifyNonSailingSource({
    url,
    title,
    description: detail,
    ship_name_guess: payload.raw_ship_name || payload.ship_name_guess,
    ship_name_guesses: payload.ship_name_guesses || [],
    ship_id: payload.ship_id,
    departure_date: payload.departure_date
  });
  if (nonSailing.rejected) {
    return {
      category: "non_sailing",
      cause: nonSailing.reason,
      codePath: "discovery-non-sailing-filter (missed at ingestion)"
    };
  }

  const groupKey = payload.entity_group_key || item.entity_group_key;
  if (groupKey) {
    const dupes = allItems.filter(
      (other) =>
        other.id !== item.id &&
        (other.payload?.entity_group_key || other.entity_group_key) === groupKey
    );
    if (dupes.length) {
      return { category: "duplicate", cause: "shared_entity_group_key", codePath: "dedupeReviewItems / collapse" };
    }
  }

  const cruise = item.cruise_id ? cruiseById.get(item.cruise_id) : null;
  if (cruise?.status === "expired" || cruise?.status === "hidden") {
    return { category: "obsolete", cause: `linked_cruise_${cruise.status}`, codePath: "expireSailedCruises / purge" };
  }

  if (item.item_type === "missing_ship_url") {
    return {
      category: "human_review",
      cause: "missing_official_ship_url",
      codePath: "buildCandidateFromSource suggested_official_ship_url"
    };
  }

  if (item.item_type === "unknown_ship" && payload.suggested_matches?.length) {
    return {
      category: "auto_resolvable",
      cause: "suggested_ship_match_available",
      codePath: "buildEntityReviewPayload / alias resolution"
    };
  }

  if (item.item_type === "unknown_destination" && payload.suggested_destinations?.length) {
    return {
      category: "auto_resolvable",
      cause: "suggested_destination_available",
      codePath: "buildEntityReviewPayload destination suggestions"
    };
  }

  if (
    item.item_type === "validation_failure" &&
    /departure date|departure port|Invalid departure|Ambiguous departure/i.test(detail)
  ) {
    const evidence = evaluateSailingEvidence({
      title,
      description: detail,
      url,
      departure_date: payload.departure_date,
      ship_name_guess: payload.raw_ship_name
    });
    if (evidence.sufficient) {
      return {
        category: "poor_extraction",
        cause: "valid_sailing_missing_field",
        codePath: "validateCruise / discovery-departure-port"
      };
    }
    return {
      category: "human_review",
      cause: "validation_failure",
      codePath: "validateCruise / lifecycleFromValidation"
    };
  }

  if (item.item_type === "unknown_ship") {
    const evidence = evaluateSailingEvidence({ title, description: detail, url, ...payload });
    if (evidence.sufficient) {
      return {
        category: "poor_extraction",
        cause: "ship_not_matched_despite_signals",
        codePath: "matchEntities / matchShipWithAliases"
      };
    }
    return {
      category: "human_review",
      cause: "unknown_ship_no_auto_match",
      codePath: "matchEntities ship resolution"
    };
  }

  return {
    category: "human_review",
    cause: item.item_type || "other",
    codePath: "discoverForCruiseLine review enqueue"
  };
}

async function main() {
  const supabase = createSupabaseRest(root);
  const items = await supabase.get(
    "cruise_discovery_review_items?status=eq.pending&select=*&order=created_at.asc&limit=5000"
  );
  const cruiseIds = [...new Set((items || []).map((i) => i.cruise_id).filter(Boolean))];
  const cruiseById = new Map();
  if (cruiseIds.length) {
    const cruises = await supabase.get(
      `discovered_cruises?id=in.(${cruiseIds.map((id) => encodeURIComponent(id)).join(",")})&select=id,status,official_url,departure_date,ship_id,review_reason`
    );
    for (const c of cruises || []) cruiseById.set(c.id, c);
  }

  const counts = Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, 0]));
  const causeCounts = {};
  const codePathCounts = {};
  const classified = [];

  for (const item of items || []) {
    const result = classifyItem(item, cruiseById, items || []);
    counts[result.category] = (counts[result.category] || 0) + 1;
    causeCounts[result.cause] = (causeCounts[result.cause] || 0) + 1;
    codePathCounts[result.codePath] = (codePathCounts[result.codePath] || 0) + 1;
    classified.push({
      id: item.id,
      item_type: item.item_type,
      title: item.title,
      source_url: item.source_url,
      category: result.category,
      cause: result.cause,
      codePath: result.codePath
    });
  }

  const report = {
    generated_at: new Date().toISOString(),
    pending_total: (items || []).length,
    category_counts: counts,
    category_labels: CATEGORIES,
    top_causes: Object.entries(causeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([cause, count]) => ({ cause, count })),
    top_code_paths: Object.entries(codePathCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([codePath, count]) => ({ codePath, count })),
    auto_resolvable_count: counts.auto_resolvable || 0,
    human_review_count: counts.human_review || 0,
    non_sailing_remaining: counts.non_sailing || 0,
    items: classified
  };

  const reportsDir = path.join(root, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportsDir, `review-queue-audit-${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log("Discovery review queue audit (read-only)");
  console.log(`Pending items: ${report.pending_total}`);
  console.log("Categories:");
  for (const [key, label] of Object.entries(CATEGORIES)) {
    console.log(`  ${label}: ${counts[key] || 0}`);
  }
  console.log(`\nAuto-resolvable: ${report.auto_resolvable_count}`);
  console.log(`Genuine human review: ${report.human_review_count}`);
  console.log(`Non-sailing missed: ${report.non_sailing_remaining}`);
  console.log(`Report: ${reportPath}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
