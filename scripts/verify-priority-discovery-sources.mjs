#!/usr/bin/env node
/**
 * Verify official cruise_search_url candidates for priority Discovery lines.
 * Read-only fetch — no DB writes.
 *
 *   node scripts/verify-priority-discovery-sources.mjs
 *   node scripts/verify-priority-discovery-sources.mjs --output=reports/priority-source-verification.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { fetchSourceExcerpt } = require(path.join(root, "netlify/functions/lib/source-fetch"));
const { resolveAdapter } = require(path.join(root, "netlify/functions/lib/cruise-discovery-adapters"));
const {
  extractStructuredSailingSources,
  extractStructuredVoyages
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-structured"));
const { inferSourceUrlType } = require(path.join(root, "netlify/functions/lib/cruise-discovery-source-health"));

/** Slug → candidate official search/listing URLs (verified manually before apply). */
const CANDIDATE_URLS = {
  "holland-america-line": [
    "https://www.hollandamerica.com/en/au/cruise-search",
    "https://www.hollandamerica.com/en/au/find-a-cruise"
  ],
  "princess-cruises": [
    "https://www.princess.com/cruise-search",
    "https://www.princess.com/cruise-search/results",
    "https://www.princess.com/"
  ],
  "celebrity-cruises": [
    "https://www.celebritycruises.com/cruise-search",
    "https://www.celebritycruises.com/find-a-cruise"
  ],
  "norwegian-cruise-line": [
    "https://www.ncl.com/cruise-search",
    "https://www.ncl.com/vacations",
    "https://www.ncl.com/"
  ],
  "royal-caribbean-international": [
    "https://www.royalcaribbean.com/cruise-search",
    "https://www.royalcaribbean.com/cruises"
  ],
  "virgin-voyages": [
    "https://www.virginvoyages.com/book/voyage-search",
    "https://www.virginvoyages.com/book"
  ],
  "atlas-cruises": [
    "https://atlasoceanvoyages.com/expeditions",
    "https://atlasoceanvoyages.com/"
  ],
  "seabourn-cruise-line": [
    "https://www.seabourn.com/en/au/cruise-search",
    "https://www.seabourn.com/en/au/find-a-cruise"
  ],
  "explora-journeys": [
    "https://www.explorajourneys.com/int/en/destinations-globe",
    "https://explorajourneys.com/int/en/destinations-globe"
  ],
  "ama-waterways": [
    "https://www.amawaterways.com/cruise-search",
    "https://www.amawaterways.com/destinations"
  ]
};

function parseArgs(argv) {
  const args = { output: path.join(root, "reports/priority-source-verification.json") };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--output=")) args.output = arg.slice("--output=".length);
  }
  return args;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function sameOfficialDomain(websiteUrl, candidateUrl) {
  const a = hostnameOf(websiteUrl);
  const b = hostnameOf(candidateUrl);
  if (!a || !b) return false;
  return a === b || b.endsWith(`.${a}`) || a.endsWith(`.${b}`);
}

async function probeUrl(url) {
  const fetched = await fetchSourceExcerpt(url, {
    timeoutMs: 10000,
    maxExcerptChars: 500000,
    includeHtml: true
  });
  const html = String(fetched.html || "");
  const structured = fetched.ok ? extractStructuredSailingSources(html, url) : null;
  const voyages = fetched.ok ? extractStructuredVoyages(html, url) : null;
  return {
    url,
    fetch_ok: Boolean(fetched.ok),
    fetch_error: fetched.error || null,
    http_status: fetched.status || null,
    html_bytes: html.length,
    javascript_empty: html.length > 0 && html.length < 1200 && !structured?.hasStructured,
    sailing_urls_found: structured?.sailingUrls?.length || 0,
    structured_voyages_found: voyages?.voyages?.length || 0,
    structured_methods: structured?.methods || [],
    voyage_methods: voyages?.methods || [],
    source_type: inferSourceUrlType({ cruise_search_url: url }),
    likely_sailing_pages:
      (structured?.sailingUrls?.length || 0) + (voyages?.voyages?.length || 0)
  };
}

function pickBest(candidates) {
  const ok = candidates.filter((c) => c.fetch_ok && c.official_domain_ok);
  if (!ok.length) return candidates[0] || null;
  return [...ok].sort((a, b) => {
    const score = (r) =>
      (r.structured_voyages_found > 0 ? 1000 : 0) +
      (r.sailing_urls_found > 0 ? 500 : 0) +
      r.sailing_urls_found +
      r.structured_voyages_found +
      Math.min(r.html_bytes / 1000, 50) -
      (r.url.replace(/\/$/, "") === String(r.website_url || "").replace(/\/$/, "") ? 1 : 0);
    return score(b) - score(a);
  })[0];
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createSupabaseRest(root);
  const slugs = Object.keys(CANDIDATE_URLS);
  const lines = await sb.get(
    `ci_cruise_lines?slug=in.(${slugs.map((s) => encodeURIComponent(s)).join(",")})&select=id,name,slug,website_url,cruise_search_url&order=name.asc`
  );

  const results = [];
  for (const line of lines || []) {
    process.stderr.write(`Verifying ${line.name}…\n`);
    const candidates = CANDIDATE_URLS[line.slug] || [];
    const probed = [];
    for (const url of candidates) {
      probed.push({
        ...(await probeUrl(url)),
        official_domain_ok: sameOfficialDomain(line.website_url, url),
        website_url: line.website_url
      });
    }
    const best = pickBest(probed);
    const adapter = resolveAdapter(line);
    results.push({
      cruise_line_id: line.id,
      cruise_line_name: line.name,
      slug: line.slug,
      website_url: line.website_url,
      current_cruise_search_url: line.cruise_search_url,
      adapter_id: adapter.id,
      category: line.slug.includes("ama") ? "river" : line.slug.includes("atlas") ? "expedition" : "ocean",
      candidates_probed: probed,
      recommended_cruise_search_url: best?.official_domain_ok && best?.likely_sailing_pages > 0 ? best.url : null,
      recommended_source_type: best?.source_type || null,
      recommended_fetch_ok: best?.fetch_ok || false,
      recommended_sailing_links: best?.sailing_urls_found || 0,
      recommended_structured_voyages: best?.structured_voyages_found || 0,
      recommended_likely_pages: best?.likely_sailing_pages || 0,
      recommended_javascript_empty: best?.javascript_empty || false,
      expected_extraction_method:
        best?.structured_voyages_found > 0
          ? "structured_voyage_json"
          : best?.sailing_urls_found > 0
            ? "official_search_page_links"
            : "none",
      rejection_reason:
        !best?.fetch_ok
          ? best?.fetch_error || "fetch_failed"
          : !best?.official_domain_ok
            ? "third_party_domain"
            : best?.likely_sailing_pages === 0
              ? "no_usable_voyage_links"
              : null
    });
  }

  const report = {
    generated_at: new Date().toISOString(),
    mode: "read_only_verification",
    writes_performed: false,
    lines_verified: results.length,
    recommended_count: results.filter((r) => r.recommended_cruise_search_url).length,
    per_line: results
  };

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    lines_verified: report.lines_verified,
    recommended_count: report.recommended_count,
    output: args.output
  }, null, 2));
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
