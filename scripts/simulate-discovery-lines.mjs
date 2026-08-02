#!/usr/bin/env node
/**
 * Read-only per-line Discovery source probe.
 * Fetches official sources and reports extraction potential — NO DB WRITES.
 *
 *   node scripts/simulate-discovery-lines.mjs
 *   node scripts/simulate-discovery-lines.mjs --lines=3
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
  extractStructuredVoyages,
  extractSitemapLocs
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-structured"));
const { buildLineHealthRow } = require(path.join(root, "netlify/functions/lib/cruise-discovery-source-health"));

function parseArgs(argv) {
  const args = { lines: 0, slugs: [], output: path.join(root, "reports/discovery-lines-simulation.json") };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--lines=")) args.lines = Number(arg.slice("--lines=".length)) || 0;
    if (arg.startsWith("--slugs=")) args.slugs = arg.slice("--slugs=".length).split(",").map((s) => s.trim()).filter(Boolean);
    if (arg.startsWith("--output=")) args.output = arg.slice("--output=".length);
  }
  return args;
}

async function probeLine(line, runs, activeFutureByLine, activeAllByLine) {
  const adapter = resolveAdapter(line);
  const sourceUrl = line.cruise_search_url || line.website_url;
  const result = {
    cruise_line_id: line.id,
    cruise_line: line.name,
    adapter_id: adapter.id,
    source_url: sourceUrl,
    fetch_ok: false,
    http_status: null,
    html_bytes: 0,
    javascript_empty: false,
    structured_methods: [],
    voyage_methods: [],
    sailing_urls_found: 0,
    structured_voyages_found: 0,
    sitemap_urls_found: 0,
    api_hints: [],
    likely_sailing_pages: 0,
    primary_issue: null,
    source_health: null
  };

  if (!sourceUrl) {
    result.primary_issue = "missing source URL";
    result.source_health = buildLineHealthRow({
      line,
      runs,
      activeFutureByLine,
      activeAllByLine
    }).source_health;
    return result;
  }

  const fetched = await fetchSourceExcerpt(sourceUrl, {
    timeoutMs: 8000,
    maxExcerptChars: 500000,
    includeHtml: true
  });
  result.fetch_ok = Boolean(fetched.ok);
  result.http_status = fetched.status || null;
  result.html_bytes = String(fetched.html || "").length;
  if (!fetched.ok) {
    result.primary_issue = fetched.error || "fetch_failed";
  } else {
    const structured = extractStructuredSailingSources(fetched.html, sourceUrl);
    const voyages = extractStructuredVoyages(fetched.html, sourceUrl);
    result.structured_methods = structured.methods || [];
    result.voyage_methods = voyages.methods || [];
    result.sailing_urls_found = structured.sailingUrls?.length || 0;
    result.structured_voyages_found = voyages.voyages?.length || 0;
    result.api_hints = structured.apiHints || [];
    result.javascript_empty = result.html_bytes < 1200 && !structured.hasStructured;
    result.likely_sailing_pages = result.sailing_urls_found + result.structured_voyages_found;

    if (result.javascript_empty) result.primary_issue = "javascript_empty_html";
    else if (result.structured_voyages_found === 0 && result.sailing_urls_found === 0) {
      result.primary_issue = "no_sailing_urls_in_source";
    }

    try {
      const origin = new URL(sourceUrl).origin;
      for (const p of adapter.sitemapPaths || ["/sitemap.xml"]) {
        const sm = await fetchSourceExcerpt(`${origin}${p}`, {
          timeoutMs: 5000,
          maxExcerptChars: 500000,
          includeHtml: true
        });
        if (sm.ok && sm.html) {
          const locs = extractSitemapLocs(sm.html, origin);
          result.sitemap_urls_found = locs.length;
          if (locs.length && !result.likely_sailing_pages) {
            result.primary_issue = "sitemap_has_sailing_urls";
            result.likely_sailing_pages = locs.length;
          }
          break;
        }
      }
    } catch {
      /* ignore sitemap errors */
    }
  }

  result.source_health = buildLineHealthRow({
    line,
    runs,
    activeFutureByLine,
    activeAllByLine
  }).source_health;

  return result;
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createSupabaseRest(root);
  const [lines, runs, activeFuture, activeAll] = await Promise.all([
    sb.get(
      "ci_cruise_lines?active=eq.true&sold_by_101cruise=eq.true&select=id,name,slug,website_url,cruise_search_url,fleet_page_url,active,sold_by_101cruise&order=name.asc"
    ),
    sb.get(
      "cruise_discovery_runs?select=id,scope,status,stats,started_at,finished_at,cruise_line_id,error_message&order=created_at.desc&limit=200"
    ),
    sb.get(
      `discovered_cruises?status=eq.active&or=(departure_date.is.null,departure_date.gte.${new Date().toISOString().slice(0, 10)})&select=id,cruise_line_id`
    ),
    sb.get("discovered_cruises?status=eq.active&select=id,cruise_line_id")
  ]);

  const activeFutureByLine = {};
  for (const r of activeFuture || []) {
    activeFutureByLine[r.cruise_line_id] = (activeFutureByLine[r.cruise_line_id] || 0) + 1;
  }
  const activeAllByLine = {};
  for (const r of activeAll || []) {
    activeAllByLine[r.cruise_line_id] = (activeAllByLine[r.cruise_line_id] || 0) + 1;
  }

  const targetLines = args.lines > 0 ? (lines || []).slice(0, args.lines) : lines || [];
  const perLine = [];
  for (const line of targetLines) {
    process.stderr.write(`Probing ${line.name}…\n`);
    perLine.push(await probeLine(line, runs || [], activeFutureByLine, activeAllByLine));
  }

  const summary = {
    enabled_lines: (lines || []).length,
    probed_lines: perLine.length,
    fetch_ok: perLine.filter((r) => r.fetch_ok).length,
    fetch_failed: perLine.filter((r) => !r.fetch_ok).length,
    lines_with_structured_voyages: perLine.filter((r) => r.structured_voyages_found > 0).length,
    lines_with_sailing_urls: perLine.filter((r) => r.sailing_urls_found > 0).length,
    lines_with_sitemap_urls: perLine.filter((r) => r.sitemap_urls_found > 0).length,
    javascript_empty_lines: perLine.filter((r) => r.javascript_empty).length,
    misconfigured_lines: perLine.filter((r) => r.source_health === "misconfigured").length,
    projected_active_inventory: (activeFuture || []).length,
    lines_with_future_active: Object.keys(activeFutureByLine).length
  };

  const report = {
    generated_at: new Date().toISOString(),
    mode: "read_only_simulation",
    writes_performed: false,
    summary,
    per_line: perLine
  };

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, JSON.stringify(report, null, 2));

  console.log("Discovery line simulation (READ ONLY, NO WRITES)");
  console.log(JSON.stringify(summary, null, 2));
  console.log("Report:", args.output);
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
