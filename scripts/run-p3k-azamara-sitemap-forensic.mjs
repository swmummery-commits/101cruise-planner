#!/usr/bin/env node
/**
 * P3K Azamara sitemap forensic — production-equivalent Node fetch.
 * Unique preflight namespace. Does not claim Friday scheduled lease.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createMaintenanceSupabase, getSupabaseConfig } = require(
  path.join(root, "scripts/lib/supabase-rest.cjs")
);
const { scheduledWeeklyDispatchKey } = require(
  path.join(root, "netlify/functions/lib/weekly-maintenance-schedule-control")
);
const { loadMaintenanceLockStatus } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks")
);
const {
  extractAzamaraPackagesFromSitemapXml,
  parsePackageFromUrl
} = require(path.join(root, "netlify/functions/lib/azamara-discovery-adapter"));
const { extractSitemapLocs } = require(path.join(root, "netlify/functions/lib/cruise-discovery-structured"));
const { publicBookingMinimumDepartureDate, perthCalendarDate } = require(
  path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory")
);

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const PACKAGE_RE = /\/cruises\/((jr|on|pr|qs)(\d{2})(\d{2})(\d{2})-(\d{3})(?:-(ct[ab]\d+))?)/gi;

const CANDIDATES = [
  { url: "https://www.azamara.com/sitemap.xml", accept: "application/xml,text/xml,*/*;q=0.8" },
  { url: "https://www.azamara.com/sitemap", accept: "application/xml,text/xml,*/*;q=0.8" },
  {
    url: "https://www.azamara.com/sitemap.xml",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  }
];

async function fetchWithChain(url, accept, maxHops = 8) {
  const chain = [];
  let current = url;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const res = await fetch(current, {
      redirect: "manual",
      headers: { Accept: accept, "User-Agent": UA, "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(45000)
    });
    const location = res.headers.get("location");
    chain.push({
      url: current,
      status: res.status,
      location,
      content_type: res.headers.get("content-type"),
      content_length: res.headers.get("content-length")
    });
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).href;
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      requested_url: url,
      status: res.status,
      final_url: current,
      content_type: res.headers.get("content-type"),
      header_content_length: res.headers.get("content-length"),
      bytes: buf.length,
      sha256: crypto.createHash("sha256").update(buf).digest("hex"),
      first_500: buf.slice(0, 500).toString("utf8"),
      text: buf.toString("utf8"),
      redirect_chain: chain
    };
  }
  throw new Error(`too_many_redirects:${url}`);
}

function classifyBody(text) {
  const t = String(text || "");
  const lower = t.slice(0, 4000).toLowerCase();
  return {
    contains_urlset: /<urlset/i.test(t),
    contains_sitemapindex: /<sitemapindex/i.test(t),
    looks_consent: /onetrust|cookie consent|gdpr/i.test(lower),
    looks_waf: /access denied|cloudflare|attention required|captcha|akamai/i.test(lower),
    looks_html_error: /<html/i.test(t) && !/<urlset|<sitemapindex/i.test(t)
  };
}

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const periodKey = scheduledWeeklyDispatchKey("azamara");
  const leaseBefore = await loadMaintenanceLockStatus(sb, periodKey);

  const today = perthCalendarDate();
  const minDep = publicBookingMinimumDepartureDate(today);
  const results = [];
  for (const candidate of CANDIDATES) {
    let fetched;
    try {
      fetched = await fetchWithChain(candidate.url, candidate.accept);
    } catch (error) {
      results.push({
        requested_url: candidate.url,
        accept: candidate.accept,
        error: error.message
      });
      continue;
    }
    const extracted = extractAzamaraPackagesFromSitemapXml(fetched.text, candidate.url);
    const locs = extractSitemapLocs(fetched.text, candidate.url);
    const rawLoc = (fetched.text.match(/<loc>/gi) || []).length;
    const regexMatches = [...fetched.text.matchAll(PACKAGE_RE)].map((m) => m[1].toUpperCase());
    const uniqueRegex = [...new Set(regexMatches)];
    const cutoffExcluded = extracted.packages.filter((p) => p.departure < minDep).length;
    const cruisetours = extracted.packages.filter((p) => p.isCruisetour).length;
    const eligible = extracted.packages.filter((p) => !p.isCruisetour && p.departure >= minDep);
    results.push({
      requested_url: candidate.url,
      accept: candidate.accept,
      http_status: fetched.status,
      redirect_chain: fetched.redirect_chain,
      final_url: fetched.final_url,
      content_type: fetched.content_type,
      header_content_length: fetched.header_content_length,
      actual_bytes: fetched.bytes,
      sha256: fetched.sha256,
      first_500: fetched.first_500,
      body_class: classifyBody(fetched.text),
      contains_urlset: /<urlset/i.test(fetched.text),
      contains_sitemapindex: /<sitemapindex/i.test(fetched.text),
      raw_loc_count: rawLoc,
      extractSitemapLocs_count: locs.length,
      package_regex_count: regexMatches.length,
      unique_package_code_count: uniqueRegex.length,
      extracted_package_count: extracted.packages.length,
      cutoff_excluded: cutoffExcluded,
      cruisetours,
      eligible_package_urls: eligible.length,
      sample_package_codes: extracted.packages.slice(0, 12).map((p) => p.fullCode)
    });
  }

  const leaseAfter = await loadMaintenanceLockStatus(sb, periodKey);
  const report = {
    generated_at: new Date().toISOString(),
    runtime: "node_fetch_redirect_manual_then_body_chrome_ua",
    today,
    min_public_departure: minDep,
    lease_before_held: leaseBefore.held === true,
    lease_after_held: leaseAfter.held === true,
    lease_created: leaseBefore.held !== true && leaseAfter.held === true,
    lease_owner_before: leaseBefore.owner_id || null,
    results
  };
  const file = path.join(root, "reports", `azamara-p3k-sitemap-forensic-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        report_file: file,
        lease_created: report.lease_created,
        summaries: results.map((r) => ({
          url: r.requested_url,
          accept: r.accept,
          status: r.http_status || r.error,
          final: r.final_url,
          type: r.content_type,
          bytes: r.actual_bytes,
          locs: r.extractSitemapLocs_count,
          packages: r.extracted_package_count,
          eligible: r.eligible_package_urls,
          class: r.body_class
        }))
      },
      null,
      2
    )
  );
  if (report.lease_created) process.exit(2);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
