#!/usr/bin/env node
/**
 * Read-only HAL source diagnostic for the Monday collapse (eligible 46 vs ~1116).
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENDPOINT = "https://www.hollandamerica.com/search/halcruisesearch";
const REPORT_DIR = path.join(root, "reports");

async function fetchPage(start, size = 100) {
  const url = `${ENDPOINT}?q=${encodeURIComponent("*")}&size=${size}&start=${start}`;
  const started = Date.now();
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "101cruise-discovery/1.0 (+https://101cruise.com.au)"
    },
    redirect: "follow"
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  let json = null;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    json = null;
  }
  return {
    url,
    final_url: response.url,
    status: response.status,
    redirected: response.redirected,
    content_type: response.headers.get("content-type"),
    bytes: bytes.length,
    elapsed_ms: Date.now() - started,
    num_found: Number(json?.response?.numFound) || 0,
    start: Number(json?.response?.start) || start,
    docs: json?.response?.docs || [],
    parse_ok: Boolean(json?.response)
  };
}

async function enumerate(label) {
  const pages = [];
  const identities = new Set();
  let start = 0;
  let numFound = 0;
  for (let i = 0; i < 80; i += 1) {
    const page = await fetchPage(start, 100);
    pages.push({
      start,
      status: page.status,
      final_url: page.final_url,
      content_type: page.content_type,
      bytes: page.bytes,
      docs: page.docs.length,
      num_found: page.num_found,
      parse_ok: page.parse_ok,
      elapsed_ms: page.elapsed_ms
    });
    if (!page.parse_ok || page.status >= 400) break;
    numFound = page.num_found || numFound;
    for (const doc of page.docs) {
      if (doc?.cruiseId && doc?.departDate) identities.add(`${doc.cruiseId}|${doc.departDate}`);
    }
    if (!page.docs.length) break;
    start += page.docs.length;
    if (start >= numFound) break;
  }
  return {
    label,
    first_page: pages[0] || null,
    page_count: pages.length,
    num_found: numFound,
    unique_identities: identities.size,
    last_start: start,
    pages
  };
}

async function main() {
  const a = await enumerate("run-1");
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const b = await enumerate("run-2");
  const report = {
    endpoint: ENDPOINT,
    compared_at: new Date().toISOString(),
    monday_failed_eligible: 46,
    previous_eligible_approx: 1116,
    run_1: a,
    run_2: b
  };
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const out = path.join(REPORT_DIR, `hal-p3e-source-diagnostic-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        report: out,
        run_1: { status: a.first_page?.status, num_found: a.num_found, identities: a.unique_identities, pages: a.page_count },
        run_2: { status: b.first_page?.status, num_found: b.num_found, identities: b.unique_identities, pages: b.page_count }
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
