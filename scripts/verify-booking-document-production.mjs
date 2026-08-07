#!/usr/bin/env node
/**
 * Server-side production verification for booking document mirror release.
 * Does not log credentials, surnames, signed URLs, Base44 URLs or storage paths.
 */

import { execSync } from "child_process";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const PROD = "https://admirable-tiramisu-d4da8a.netlify.app";

const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
createSupabaseRest(root);

function loadNetlifyEnv(name) {
  const netlifyBin =
    process.env.NETLIFY_CLI_BIN ||
    "/Users/stevemummery/.npm/_npx/5897f426ba328dd1/node_modules/.bin/netlify";
  const raw = execSync(`${netlifyBin} env:get ${name} --context production`, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000
  });
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith("npm warn"));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const v = lines[i];
    if (v && !/No value set/i.test(v)) return v;
  }
  return "";
}

async function main() {
  const sb = createSupabaseRest(root);
  const report = { production_url: PROD, checks: [] };

  let mirrorApplied = false;
  try {
    await sb.get("booking_documents?select=source_fingerprint,is_active&limit=1");
    mirrorApplied = true;
  } catch {
    mirrorApplied = false;
  }
  report.migration_applied = mirrorApplied;

  const selectFields = mirrorApplied
    ? "id,booking_reference,document_type,filename,storage_path,storage_bucket,file_url,source_fingerprint,is_active,source_system"
    : "id,booking_reference,document_type,filename,storage_path,file_url,source_system";
  const bookingDocs = await sb.get(
    `booking_documents?select=${selectFields}&source_system=eq.base44`
  );
  const customerDocs = await sb.get("customer_documents?select=id&limit=1").catch(() => []);

  report.counts = {
    booking_documents: bookingDocs.length,
    customer_documents: Array.isArray(customerDocs) ? customerDocs.length : 0,
    mirrored_storage: bookingDocs.filter((r) => r.storage_path).length,
    legacy_file_url_only: bookingDocs.filter((r) => !r.storage_path && r.file_url).length,
    active_base44: bookingDocs.filter((r) => r.is_active !== false).length
  };

  const swm = bookingDocs.filter((r) => r.booking_reference === "SWM123456");
  report.swm123456 = {
    document_count: swm.length,
    types: swm.map((r) => r.document_type),
    has_confirmation: swm.some((r) => /booking confirmation/i.test(r.document_type || "")),
    has_terms: swm.some((r) => /terms|other/i.test(String(r.document_type || r.filename || ""))),
    both_mirrored: swm.length >= 2 && swm.every((r) => Boolean(r.storage_path))
  };

  const cacheRows = await sb.get(
    "base44_booking_cache?booking_reference=eq.SWM123456&select=raw_payload&limit=1"
  );
  const surname = String(cacheRows?.[0]?.raw_payload?.passenger1_last_name || "").trim();
  if (!surname) {
    report.portal_api = { skipped: true, reason: "surname_unavailable" };
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const accessRes = await fetch(`${PROD}/.netlify/functions/customer-access`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ booking_reference: "SWM123456", surname: surname.toUpperCase() })
  });
  const access = await accessRes.json().catch(() => ({}));
  if (!accessRes.ok || !access.token) {
    report.portal_api = { skipped: true, reason: "customer_access_failed", status: accessRes.status };
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const token = access.token;
  const listRes = await fetch(`${PROD}/.netlify/functions/customer-documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action: "list_all" })
  });
  const list = await listRes.json().catch(() => ({}));
  const docs = list.documents || [];
  const crm = docs.filter((d) => d.source === "crm");

  const bodyStr = JSON.stringify(list);
  report.portal_api = {
    list_ok: listRes.ok,
    total_documents: docs.length,
    crm_documents: crm.length,
    crm_deletable: crm.filter((d) => d.deletable).length,
    crm_sources: [...new Set(crm.map((d) => d.source))],
    types: crm.map((d) => d.document_type),
    exposes_file_url: /https?:\/\//.test(bodyStr) && /file_url/.test(bodyStr),
    exposes_storage_path: /storage_path|booking-documents\//.test(bodyStr),
    exposes_base44: /base44/i.test(bodyStr)
  };

  const dlChecks = [];
  for (const doc of crm.slice(0, 2)) {
    const dlRes = await fetch(`${PROD}/.netlify/functions/customer-documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "get_download_url", id: doc.id, source: doc.source })
    });
    const dl = await dlRes.json().catch(() => ({}));
    dlChecks.push({
      id: doc.id,
      type: doc.document_type,
      ok: dlRes.ok && Boolean(dl.url),
      url_is_signed: Boolean(dl.url && (dl.url.includes("token=") || dl.url.includes("/sign/")))
    });
  }
  report.portal_api.download_checks = dlChecks;

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
