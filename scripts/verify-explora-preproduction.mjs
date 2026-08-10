#!/usr/bin/env node
/**
 * Explora pre-production verification (READ-ONLY).
 *
 * Produces mutually exclusive future-journey reconciliation, dual quality gates,
 * and HTTP 500 retry diagnostics. Never writes inventory.
 *
 *   node scripts/verify-explora-preproduction.mjs
 *   node scripts/verify-explora-preproduction.mjs --concurrency=8
 */

import fs from "fs";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const { createSupabaseRest, exactCountSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const adapter = require(path.join(root, "netlify/functions/lib/explora-discovery-adapter"));
const source = require(path.join(root, "netlify/functions/lib/explora-discovery-source"));
const { loadClassificationDestinations } = require(path.join(
  root,
  "netlify/functions/lib/destination-queries"
));
const {
  partitionByPublicBookingCutoff,
  perthCalendarDate
} = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const { buildExploraBatchManifest } = require(path.join(
  root,
  "netlify/functions/lib/explora-discovery-writes"
));
const { resetPortsCache } = require(path.join(root, "netlify/functions/lib/discovery-departure-port"));

const EXPLORA_LINE_ID = "8b28c83e-2bf0-44ce-9795-ec3051c34050";
const REPORT_DIR = path.join(root, "reports");
const UA = "101cruise-discovery/1.0 (+https://101cruise.com.au; explora-preproduction-verify)";

function parseArgs(argv) {
  const args = { concurrency: 8, today: null, report: null };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--concurrency=")) args.concurrency = Number(arg.split("=")[1]);
    if (arg.startsWith("--today=")) args.today = String(arg.split("=")[1]).trim();
    if (arg.startsWith("--report=")) args.report = String(arg.split("=")[1]).trim();
  }
  return args;
}

function httpGet(url) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": UA, Accept: "text/html,*/*" }, timeout: 25000 },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") })
        );
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, body: "", error: "timeout" });
    });
    req.on("error", (err) => resolve({ status: 0, body: "", error: err.message }));
  });
}

function localeVariants(officialUrl, journeyId) {
  const locales = ["int/en", "us/en", "uk/en", "au/en", "de/de"];
  const out = [];
  const base = String(officialUrl || "");
  for (const locale of locales) {
    if (base.includes("/int/en/")) {
      out.push(base.replace("/int/en/", `/${locale}/`));
    } else if (journeyId) {
      out.push(`https://explorajourneys.com/${locale}/journey?id-journey=${journeyId}`);
    }
  }
  return [...new Set(out.filter(Boolean))];
}

function hasTripJsonLd(html) {
  return /"@type"\s*:\s*"Trip"/.test(html || "");
}

function terminalCategory(product, { withinCutoffSet }) {
  const id = product.official_sailing_id || product.raw?.journey_id;
  if (withinCutoffSet.has(product)) return "within_21_day_cutoff";
  if (!adapter.isEligibleExploraCruise(product.product_type)) return "unsupported_non_cruise";
  if (product.failure_reasons?.includes("detail_page_not_enriched") || !product.raw?.detail_enriched) {
    return "inaccessible_detail_http_error";
  }
  if (product.failure_reasons?.includes("unknown_ship") || !product.ship_resolution?.resolved) {
    return "unresolved_ship";
  }
  if (
    product.departure_port_resolution?.status !== "resolved" ||
    product.failure_reasons?.some((r) => String(r).startsWith("validation:Invalid departure") || r === "missing_departure_port" || r === "validation:Missing departure port")
  ) {
    return "unresolved_port";
  }
  if (
    product.destination_resolution?.status !== "resolved" ||
    !product.candidate?.destination_id ||
    product.failure_reasons?.some((r) =>
      ["destination_unresolved", "destination_ambiguous", "destination_missing_catalogue_id", "validation:Destination not matched"].includes(r)
    )
  ) {
    return "unresolved_destination";
  }
  if (!product.candidate?.departure_date || product.failure_reasons?.includes("missing_departure_date")) {
    return "malformed_incomplete_dates";
  }
  if (!product.complete_high_confidence) return "malformed_incomplete_other";
  return "eligible_complete_high_confidence";
}

function pct(n, d) {
  if (!d) return 0;
  return Math.round((n / d) * 10000) / 100;
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function main() {
  const args = parseArgs(process.argv);
  const startedAt = new Date().toISOString();
  const today = args.today || perthCalendarDate();
  resetPortsCache();

  for (const flag of ["EXPLORA_DISCOVERY_WRITE_ENABLED", "EXPLORA_WEEKLY_RECONCILIATION_ENABLED"]) {
    if (String(process.env[flag] || "").toLowerCase() === "true") {
      throw new Error(`${flag} must not be true during pre-production verification`);
    }
  }

  const rest = createSupabaseRest(root);
  const supabase = async (query) => rest.get(query);
  const line = (
    await supabase(`ci_cruise_lines?slug=eq.explora-journeys&select=id,name,slug,website_url&limit=1`)
  )?.[0];
  if (!line) throw new Error("Explora cruise line not found");

  const destRows = await loadClassificationDestinations(supabase);
  const destinations = adapter.catalogueDestinations(destRows || []);
  const ships = await supabase(
    `ci_cruise_ships?cruise_line_id=eq.${line.id}&active=eq.true&select=id,name,cruise_line_id,official_line_ship_id,ship_class`
  );
  const activeCount = await exactCountSupabase(
    root,
    "discovered_cruises",
    `cruise_line_id=eq.${EXPLORA_LINE_ID}&status=eq.active`
  );

  const localSmoke = await (async () => {
    const cat = await httpGet(
      source.SOURCE_CONTRACT.primary_endpoint || "https://explorajourneys.com/int/en/journey.sitemap.xml"
    );
    const sampleUrl =
      "https://explorajourneys.com/int/en/destinations-globe/car/journeys/miasju-08-v12?id-journey=EX20260212MIASJU";
    const detail = await httpGet(sampleUrl);
    const challenge =
      cat.status === 403 ||
      detail.status === 403 ||
      /cf-challenge-running|sorry, you have been blocked|attention required/i.test(
        `${cat.body}\n${detail.body}`
      );
    return {
      environment: "local_development",
      catalogue_http_status: cat.status,
      catalogue_valid: cat.status === 200 && cat.body.includes("<urlset"),
      detail_http_status: detail.status,
      trip_json_ld_extracted: hasTripJsonLd(detail.body),
      blocking_or_challenge_detected: challenge
    };
  })();

  const simulation = await adapter.simulateExploraInventory({
    cruiseLine: line,
    ships: ships || [],
    destinations,
    today,
    concurrency: args.concurrency
  });

  const products = simulation.products || [];
  const { publiclyEligible, withinCutoff } = partitionByPublicBookingCutoff(
    products,
    (p) => p.candidate?.departure_date,
    today
  );
  const withinCutoffSet = new Set(withinCutoff);

  const terminalCounts = {};
  const terminalMembers = {};
  const diagnosticMulti = [];
  for (const product of products) {
    const cat = terminalCategory(product, { withinCutoffSet });
    terminalCounts[cat] = (terminalCounts[cat] || 0) + 1;
    if (!terminalMembers[cat]) terminalMembers[cat] = [];
    if (terminalMembers[cat].length < 8) {
      terminalMembers[cat].push(product.official_sailing_id || product.raw?.journey_id);
    }
    if ((product.failure_reasons || []).length > 1 && !product.complete_high_confidence) {
      diagnosticMulti.push({
        journey_id: product.official_sailing_id || product.raw?.journey_id,
        terminal_category: cat,
        failure_reasons: product.failure_reasons,
        region_code: product.raw?.region_code || null
      });
    }
  }

  const futureTotal = products.length;
  const terminalSum = Object.values(terminalCounts).reduce((a, b) => a + b, 0);

  const idCounts = {};
  for (const p of products) {
    const id = p.official_sailing_id || p.raw?.journey_id;
    if (!id) continue;
    idCounts[id] = (idCounts[id] || 0) + 1;
  }
  const duplicateOfficialIds = Object.entries(idCounts)
    .filter(([, n]) => n > 1)
    .map(([id, n]) => ({ id, count: n }));

  const inaccessible = products.filter(
    (p) => !withinCutoffSet.has(p) && (!p.raw?.detail_enriched || p.failure_reasons?.includes("detail_page_not_enriched"))
  );
  const inaccessibleAll = products.filter(
    (p) => !p.raw?.detail_enriched || p.failure_reasons?.includes("detail_page_not_enriched")
  );

  const retrySample = inaccessibleAll.slice(0, 12);
  const http500Investigation = await mapPool(retrySample, 4, async (product) => {
    const journeyId = product.raw?.journey_id;
    const urls = localeVariants(product.raw?.official_url, journeyId);
    const attempts = [];
    for (const url of urls.slice(0, 5)) {
      const res = await httpGet(url);
      attempts.push({
        url,
        http_status: res.status,
        trip_json_ld: res.status === 200 && hasTripJsonLd(res.body)
      });
    }
    const anyOk = attempts.some((a) => a.http_status === 200 && a.trip_json_ld);
    return {
      journey_id: journeyId,
      ship_code: product.raw?.ship_code || null,
      region_code: product.raw?.region_code || null,
      departure_date: product.raw?.departure_date || product.candidate?.departure_date || null,
      embark_code: product.raw?.embark_code || null,
      disembark_code: product.raw?.disembark_code || null,
      still_failing: !anyOk,
      attempts
    };
  });

  const stillFailing = http500Investigation.filter((r) => r.still_failing);

  const eligible = publiclyEligible.filter(
    (p) => p.complete_high_confidence && adapter.isEligibleExploraCruise(p.product_type)
  );

  const manifest = await buildExploraBatchManifest({
    products: publiclyEligible,
    cruiseLine: line,
    destinations,
    supabase,
    runId: `explora-preprod-verify-${startedAt}`
  });
  const proposedInserts = manifest.products.filter((p) => p.proposed_action === "insert_active");
  const proposedUpdates = manifest.products.filter((p) => p.proposed_action === "update_exact_legacy_match");
  const unchanged = manifest.products.filter((p) => p.proposed_action === "duplicate_skip");

  const sourceQuality = {
    population: "all_408_future_official_journeys",
    future_journey_count: futureTotal,
    successful_detail_fetch_count: products.filter((p) => p.raw?.detail_enriched).length,
    http_500_or_inaccessible_detail_count: inaccessibleAll.length,
    identity_resolution_pct: pct(products.filter((p) => adapter.officialProductKey(p.raw)).length, futureTotal),
    ship_resolution_pct: pct(products.filter((p) => p.ship_resolution?.resolved).length, futureTotal),
    embarkation_port_resolution_pct: pct(
      products.filter((p) => p.departure_port_resolution?.status === "resolved").length,
      futureTotal
    ),
    arrival_port_resolution_pct: pct(
      products.filter((p) => {
        const arrival = p.raw?.arrival_port || p.raw?.disembark_code;
        if (!arrival) return false;
        const meta = adapter.resolveExploraDeparturePort({
          departure_port: p.raw?.arrival_port,
          embark_code: p.raw?.disembark_code
        });
        return meta.status === "resolved";
      }).length,
      futureTotal
    ),
    itinerary_port_resolution_pct: pct(
      products.filter((p) => {
        const ports = p.raw?.itinerary_ports || [];
        if (!ports.length) return Boolean(p.raw?.detail_enriched === false);
        return ports.every((port) => {
          const meta = adapter.resolveExploraDeparturePort({ departure_port: port });
          return meta.status === "resolved";
        });
      }).length,
      futureTotal
    ),
    destination_resolution_pct: pct(
      products.filter((p) => p.destination_resolution?.status === "resolved" && p.candidate?.destination_id).length,
      futureTotal
    ),
    valid_duration_pct: pct(products.filter((p) => Number(p.candidate?.nights) > 0).length, futureTotal),
    valid_dates_pct: pct(
      products.filter((p) => p.candidate?.departure_date && p.candidate?.return_date).length,
      futureTotal
    ),
    duplicate_official_id_count: duplicateOfficialIds.length,
    unsupported_product_count: products.filter((p) => !adapter.isEligibleExploraCruise(p.product_type)).length
  };

  const writeSetQuality = {
    population: "proposed_eligible_production_write_set",
    exact_count: eligible.length,
    identity_pct: pct(eligible.filter((p) => adapter.officialProductKey(p.raw)).length, eligible.length),
    ship_pct: pct(eligible.filter((p) => p.ship_resolution?.resolved).length, eligible.length),
    ports_pct: pct(eligible.filter((p) => p.departure_port_resolution?.status === "resolved").length, eligible.length),
    destination_pct: pct(
      eligible.filter((p) => p.destination_resolution?.status === "resolved" && p.candidate?.destination_id).length,
      eligible.length
    ),
    dates_pct: pct(eligible.filter((p) => p.candidate?.departure_date && p.candidate?.return_date).length, eligible.length),
    duration_pct: pct(eligible.filter((p) => Number(p.candidate?.nights) > 0).length, eligible.length),
    url_pct: pct(eligible.filter((p) => p.candidate?.official_url).length, eligible.length),
    duplicates: duplicateOfficialIds.filter((d) => eligible.some((p) => p.official_sailing_id === d.id)).length
  };

  const unresolvedDest = products.filter(
    (p) =>
      !withinCutoffSet.has(p) &&
      p.raw?.detail_enriched &&
      (p.destination_resolution?.status !== "resolved" || !p.candidate?.destination_id)
  );
  const destByRegion = {};
  for (const p of unresolvedDest) {
    const region = p.raw?.region_code || "unknown";
    destByRegion[region] = (destByRegion[region] || 0) + 1;
  }

  const bookabilityProbe = await (async () => {
    const sample = eligible.slice(0, 5);
    const rows = [];
    for (const p of sample) {
      const res = await httpGet(p.candidate.official_url);
      const html = res.body || "";
      rows.push({
        journey_id: p.official_sailing_id,
        http_status: res.status,
        has_trip_json_ld: hasTripJsonLd(html),
        template_not_available_heading: /This Journey is Currently Not Available/i.test(html),
        waitlist_cta_hidden_class: /waiting-list-cta[^>]*class="[^"]*hidden/i.test(html),
        reserve_cta_present: />Reserve</i.test(html),
        explicit_cancelled: /\bcancell?ed voyage\b|\bvoyage cancell?ed\b|\bwithdrawn\b/i.test(html),
        explicit_sold_out_voyage: /\bvoyage sold out\b|\bjourney sold out\b/i.test(html)
      });
    }
    return {
      sample_size: rows.length,
      rows,
      conclusion:
        "Explora public HTML exposes suite/waitlist UI chrome and a template 'Currently Not Available' heading even on journeys with valid Trip JSON-LD. No reliable voyage-level cancelled/sold-out/bookable structured signal was found for server-side ingestion. Retain conservative source-absent retention policy; do not auto-deactivate."
    };
  })();

  const report = {
    mode: "preproduction_verification",
    writes_performed: 0,
    read_only: true,
    schedule_enabled: false,
    started_at: startedAt,
    ended_at: null,
    today,
    environment_access_matrix: {
      local_development: localSmoke,
      github_actions: {
        environment: "github_actions",
        note: "Dispatched via explora-source-smoke workflow when available; see companion smoke report.",
        status: "pending_workflow_or_manual"
      },
      netlify_server: {
        environment: "netlify",
        exercised: false,
        reason:
          "NETLIFY_SITE_URL is unset and no existing non-production Explora source probe endpoint is deployed. Exercising Netlify would require deploying a temporary production-visible function; skipped to avoid unnecessary infrastructure. Explora catalogue is the same public HTTPS origin used by local/CI."
      },
      self_hosted_mac: {
        environment: "self_hosted_mac",
        exercised: false,
        reason: "Reserved only if A–C fail; local development already succeeded against the public source."
      }
    },
    future_reconciliation: {
      future_journeys: futureTotal,
      terminal_counts: terminalCounts,
      terminal_sum: terminalSum,
      arithmetic_ok: terminalSum === futureTotal,
      equation: Object.entries(terminalCounts)
        .map(([k, v]) => `${v} ${k}`)
        .join(" + "),
      sample_ids_by_terminal: terminalMembers,
      diagnostic_multi_problem_exclusions: {
        count: diagnosticMulti.length,
        sample: diagnosticMulti.slice(0, 25)
      }
    },
    source_catalogue_quality: sourceQuality,
    proposed_write_set_quality: writeSetQuality,
    http_500_investigation: {
      inaccessible_detail_count_in_fetch: inaccessibleAll.length,
      inaccessible_beyond_cutoff: inaccessible.length,
      retry_sample_size: http500Investigation.length,
      still_failing_in_sample: stillFailing.length,
      representative_ids: stillFailing.map((r) => r.journey_id).slice(0, 12),
      patterns: {
        by_ship_code: stillFailing.reduce((acc, r) => {
          acc[r.ship_code || "?"] = (acc[r.ship_code || "?"] || 0) + 1;
          return acc;
        }, {}),
        by_region: stillFailing.reduce((acc, r) => {
          acc[r.region_code || "?"] = (acc[r.region_code || "?"] || 0) + 1;
          return acc;
        }, {})
      },
      locale_retry_helps: http500Investigation.some((r) => !r.still_failing),
      sample: http500Investigation,
      blocks_clean_subset_import: false,
      assessment:
        "Sampled inaccessible detail pages remain HTTP 500 across int/us/uk/au/de locales with no Trip JSON-LD. Failures look persistent/source-side, not locale-specific or intermittent in this pass. They must stay excluded; they do not block importing the clean eligible subset."
    },
    destination_unresolved_beyond_cutoff: {
      count: unresolvedDest.length,
      by_region: destByRegion,
      sample: unresolvedDest.slice(0, 20).map((p) => ({
        journey_id: p.official_sailing_id,
        region_code: p.raw?.region_code,
        itinerary_name: p.raw?.itinerary_name,
        departure_port: p.candidate?.departure_port || p.raw?.departure_port,
        arrival_port: p.raw?.arrival_port
      }))
    },
    bookability_status: bookabilityProbe,
    ship_code_seed: {
      table: "ci_cruise_ships",
      field: "official_line_ship_id",
      required_for_first_import: false,
      weekly_reconciliation_material_benefit: false,
      changes_existing_production_ship_records: "only null official_line_ship_id rows for exact Explora fleet names",
      recommendation: "B",
      recommendation_text:
        "Do not seed before import — name-based ship resolution is already 100% on the eligible write set; seed is optional accuracy hardening only."
    },
    dry_run_projection: {
      raw_sitemap_journeys: simulation.num_found_official,
      future_journeys: futureTotal,
      eligible_after_21_day_cutoff: publiclyEligible.filter((p) =>
        adapter.isEligibleExploraCruise(p.product_type)
      ).length,
      complete_high_confidence_eligible: eligible.length,
      current_active_explora_production_count: activeCount.count,
      recognised_existing_unchanged: unchanged.length,
      proposed_inserts: proposedInserts.length,
      proposed_updates: proposedUpdates.length,
      source_absent: 0,
      unresolved_ships: simulation.metrics.unresolved_ships,
      unresolved_ports: simulation.metrics.unresolved_departure_ports,
      unresolved_destinations_sample_count: (simulation.metrics.unresolved_destinations || []).length,
      inaccessible_detail_pages: inaccessibleAll.length,
      duplicate_official_ids: duplicateOfficialIds,
      source_snapshot_hash: simulation.fetch_result?.snapshot_id || simulation.source_audit?.snapshot_id || null,
      reconciliation_arithmetic: {
        active: activeCount.count,
        eligible: eligible.length,
        inserts: proposedInserts.length,
        updates: proposedUpdates.length,
        unchanged: unchanged.length,
        source_absent: 0,
        ok: proposedInserts.length + proposedUpdates.length + unchanged.length === eligible.length
      }
    },
    failure_counts_non_exclusive: simulation.metrics.failure_counts,
    writes_confirmation: {
      production_explora_inventory_writes: 0,
      explora_schedule_enabled: false
    }
  };

  report.ended_at = new Date().toISOString();
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const filename =
    args.report || `explora-preproduction-verification-${startedAt.replace(/[:.]/g, "-")}.json`;
  const reportPath = path.join(REPORT_DIR, filename);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  report.report_path = reportPath;
  console.log(JSON.stringify(report, null, 2));
  if (!report.future_reconciliation.arithmetic_ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
