#!/usr/bin/env node
/**
 * P3K Azamara detail-page forensic. Unique preflight. Does not claim Friday lease.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  extractAzamaraPackagesFromSitemapXml,
  parsePackageFromUrl,
  buildAzamaraCandidatePayload,
  defaultFetchSitemap
} = require(path.join(root, "netlify/functions/lib/azamara-discovery-adapter"));
const {
  extractAzamaraGtmFromHtml,
  azamaraStaleSourceGate,
  classifyAzamaraProduct
} = require(path.join(root, "netlify/functions/lib/azamara-discovery-source"));
const { publicBookingMinimumDepartureDate, perthCalendarDate } = require(
  path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory")
);

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function classifyHtml(text) {
  const t = String(text || "");
  const head = t.slice(0, 8000).toLowerCase();
  const title = ((t.match(/<title>([^<]+)/i) || [])[1] || "").trim();
  let kind = "unknown";
  if (/onetrust|cookie consent/i.test(head) && t.length < 20000) kind = "consent_page";
  else if (/access denied|attention required|cf-browser-verification|captcha/i.test(head)) kind = "waf_or_denied";
  else if (/page not found|404/i.test(title)) kind = "404_template";
  else if (/Award-Winning Small Ship Cruise Line/i.test(title) && !/data-gtm-package-code=/i.test(t)) kind = "generic_landing";
  else if (/__NEXT_DATA__|id="__next"/i.test(t) && !/data-gtm-package-code=/i.test(t)) kind = "js_app_shell";
  else if (/data-gtm-package-code=|<script type="application\/ld\+json"/i.test(t)) kind = "valid_cruise_detail";
  else if (/<html/i.test(t)) kind = "html_other";
  return { kind, title: title.slice(0, 160) };
}

function structuredSignals(html) {
  const t = String(html || "");
  return {
    gtm_data_attrs: /data-gtm-package-code=/i.test(t),
    json_ld: /application\/ld\+json/i.test(t),
    next_data: /__NEXT_DATA__/i.test(t),
    data_layer: /dataLayer/i.test(t),
    drupal: /drupalSettings/i.test(t),
    react: /window\.__REACT/i.test(t)
  };
}

async function fetchPage(url) {
  const started = Date.now();
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent": UA,
      "Cache-Control": "no-cache"
    },
    signal: AbortSignal.timeout(45000)
  });
  const text = await res.text();
  return {
    status: res.status,
    final_url: res.url,
    content_type: res.headers.get("content-type"),
    bytes: Buffer.byteLength(text),
    duration_ms: Date.now() - started,
    text
  };
}

function pickSample(packages) {
  const byShip = { jr: [], on: [], pr: [], qs: [] };
  for (const p of packages) {
    if (byShip[p.prefix]) byShip[p.prefix].push(p);
  }
  const picked = [];
  const seen = new Set();
  function add(row) {
    if (!row || seen.has(row.fullCode)) return;
    seen.add(row.fullCode);
    picked.push(row);
  }
  for (const prefix of ["jr", "on", "pr", "qs"]) {
    const list = byShip[prefix];
    if (!list.length) continue;
    add(list[0]);
    add(list[Math.floor(list.length / 2)]);
    add(list[list.length - 1]);
  }
  const months = new Map();
  for (const p of packages) {
    const month = p.departure.slice(0, 7);
    if (!months.has(month)) months.set(month, p);
  }
  for (const row of [...months.values()].slice(0, 8)) add(row);
  return picked.slice(0, 24);
}

async function main() {
  const sitemap = await defaultFetchSitemap(
    "https://www.azamara.com/sitemap.xml",
    5000000,
    "application/xml,text/xml,*/*;q=0.8"
  );
  if (sitemap.status !== 200) {
    throw new Error(`sitemap_http_${sitemap.status}`);
  }
  const xml = sitemap.text;
  const extracted = extractAzamaraPackagesFromSitemapXml(xml, "https://www.azamara.com/sitemap.xml");
  const minDep = publicBookingMinimumDepartureDate(perthCalendarDate());
  const eligible = extracted.packages
    .filter((p) => !p.isCruisetour && p.departure >= minDep)
    .sort((a, b) => a.departure.localeCompare(b.departure) || a.fullCode.localeCompare(b.fullCode));
  const sample = pickSample(eligible);

  const pages = [];
  for (const item of sample) {
    let page;
    try {
      page = await fetchPage(item.url);
    } catch (error) {
      pages.push({ package_code: item.fullCode, url: item.url, error: error.message });
      continue;
    }
    const gtm = extractAzamaraGtmFromHtml(page.text);
    const htmlClass = classifyHtml(page.text);
    const stale = azamaraStaleSourceGate({
      html: page.text,
      title: htmlClass.title,
      structuredVoyage: { package_code: gtm.package_code || item.fullCode },
      url: item.url,
      finalUrl: page.final_url
    });
    const product = classifyAzamaraProduct({
      packageCode: gtm.package_code || item.fullCode,
      url: item.url,
      title: gtm.cruise_name || htmlClass.title,
      officialSailingId: item.fullCode
    });
    const jsonLd = [...page.text.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)]
      .slice(0, 2)
      .map((m) => m[1].slice(0, 400));
    const nextData = (page.text.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i) || [])[1];
    pages.push({
      package_code: item.fullCode,
      departure: item.departure,
      ship_prefix: item.prefix,
      requested_url: item.url,
      status: page.status,
      final_url: page.final_url,
      content_type: page.content_type,
      body_bytes: page.bytes,
      duration_ms: page.duration_ms,
      html_kind: htmlClass.kind,
      title: htmlClass.title,
      gtm,
      structured_signals: structuredSignals(page.text),
      stale_gate: stale,
      product_type: product.productType,
      exclusion: product.exclusionReason,
      json_ld_samples: jsonLd,
      next_data_present: Boolean(nextData),
      sha256: crypto.createHash("sha256").update(page.text).digest("hex")
    });
    await new Promise((r) => setTimeout(r, 150));
  }

  const kinds = {};
  for (const p of pages) kinds[p.html_kind || p.error] = (kinds[p.html_kind || p.error] || 0) + 1;
  const report = {
    generated_at: new Date().toISOString(),
    sitemap_packages: extracted.packages.length,
    eligible_urls: eligible.length,
    sample_size: pages.length,
    html_kind_counts: kinds,
    gtm_duration_present: pages.filter((p) => p.gtm?.nights).length,
    stale_count: pages.filter((p) => p.stale_gate).length,
    http_not_200: pages.filter((p) => p.status && p.status !== 200).length,
    median_ms: [...pages.map((p) => p.duration_ms).filter(Boolean)].sort((a, b) => a - b)[
      Math.floor(pages.filter((p) => p.duration_ms).length / 2)
    ],
    serial_projected_ms_for_eligible: null,
    pages
  };
  const times = pages.map((p) => p.duration_ms).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (times.length) {
    report.median_ms = times[Math.floor(times.length / 2)];
    report.p95_ms = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))];
    report.serial_projected_ms_for_eligible = Math.round(report.median_ms * eligible.length);
  }
  const file = path.join(root, "reports", `azamara-p3k-detail-sample-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        report_file: file,
        eligible: eligible.length,
        sample: pages.length,
        kinds,
        gtm_nights: report.gtm_duration_present,
        stale: report.stale_count,
        median_ms: report.median_ms,
        p95_ms: report.p95_ms,
        serial_projected_s: report.serial_projected_ms_for_eligible
          ? Math.round(report.serial_projected_ms_for_eligible / 1000)
          : null
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
