#!/usr/bin/env node
/**
 * Portal check for a booking reference (no secrets in output).
 * Usage: node scripts/verify-booking-portal.mjs BOOKING_REF
 */

import { execSync } from "child_process";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const bookingRef = String(process.argv[2] || "").trim().toUpperCase();
if (!bookingRef) {
  console.error("Usage: node scripts/verify-booking-portal.mjs BOOKING_REF");
  process.exit(1);
}

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const PROD = "https://admirable-tiramisu-d4da8a.netlify.app";

const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const sb = createSupabaseRest(root);

async function main() {
  const rows = await sb.get(
    `booking_documents?select=id,document_type,filename,storage_path,file_url,is_active&booking_reference=eq.${encodeURIComponent(bookingRef)}&source_system=eq.base44`
  );
  const cacheRows = await sb.get(
    `base44_booking_cache?booking_reference=eq.${encodeURIComponent(bookingRef)}&select=raw_payload&limit=1`
  );
  const surname = String(cacheRows?.[0]?.raw_payload?.passenger1_last_name || "").trim();

  const report = {
    booking_reference: bookingRef,
    db: {
      count: rows.length,
      mirrored: rows.filter((r) => r.storage_path).length,
      legacy: rows.filter((r) => !r.storage_path && r.file_url).length,
      types: rows.map((r) => r.document_type)
    },
    portal: { skipped: !surname, reason: surname ? null : "surname_unavailable" }
  };

  if (!surname) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const accessRes = await fetch(`${PROD}/.netlify/functions/customer-access`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ booking_reference: bookingRef, surname: surname.toUpperCase() })
  });
  const access = await accessRes.json().catch(() => ({}));
  if (!accessRes.ok || !access.token) {
    report.portal = { ok: false, status: accessRes.status, stage: "customer_access" };
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const listRes = await fetch(`${PROD}/.netlify/functions/customer-documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${access.token}` },
    body: JSON.stringify({ action: "list_all" })
  });
  const list = await listRes.json().catch(() => ({}));
  const crm = (list.documents || []).filter((d) => d.source === "crm");
  const bodyStr = JSON.stringify(list);

  report.portal = {
    ok: listRes.ok,
    crm_count: crm.length,
    crm_deletable: crm.filter((d) => d.deletable).length,
    types: crm.map((d) => d.document_type),
    exposes_file_url: /https?:\/\//.test(bodyStr) && /file_url/.test(bodyStr),
    exposes_storage_path: /storage_path|booking-documents\//.test(bodyStr),
    downloads: []
  };

  for (const doc of crm) {
    const dlRes = await fetch(`${PROD}/.netlify/functions/customer-documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${access.token}` },
      body: JSON.stringify({ action: "get_download_url", id: doc.id, source: doc.source })
    });
    const dl = await dlRes.json().catch(() => ({}));
    report.portal.downloads.push({
      type: doc.document_type,
      ok: dlRes.ok && Boolean(dl.url),
      signed: Boolean(dl.url && (dl.url.includes("token=") || dl.url.includes("/sign/")))
    });
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
