#!/usr/bin/env node
/**
 * Measure production customer-access latency (no PII in output).
 * Usage: node scripts/profile-customer-access.mjs BOOKING_REF1 [BOOKING_REF2 ...]
 */

import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const PROD = "https://admirable-tiramisu-d4da8a.netlify.app";

const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const sb = createSupabaseRest(root);

const refs = process.argv.slice(2).map((r) => String(r).trim().toUpperCase()).filter(Boolean);
if (!refs.length) {
  console.error("Usage: node scripts/profile-customer-access.mjs BOOKING_REF ...");
  process.exit(1);
}

async function profile(ref) {
  const cacheRows = await sb.get(
    `base44_booking_cache?booking_reference=eq.${encodeURIComponent(ref)}&select=passenger1_last_name&limit=1`
  );
  const surname = String(cacheRows?.[0]?.passenger1_last_name || "").trim();
  if (!surname) {
    return { booking_reference: ref, skipped: true, reason: "surname_unavailable" };
  }

  const started = Date.now();
  const response = await fetch(`${PROD}/.netlify/functions/customer-access`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ booking_reference: ref, surname: surname.toUpperCase() })
  });
  const elapsed_ms = Date.now() - started;
  const body = await response.json().catch(() => ({}));

  return {
    booking_reference: ref,
    status: response.status,
    ok: response.ok,
    elapsed_ms,
    has_token: Boolean(body.token),
    retryable: body.retryable === true,
    error: body.error || null
  };
}

async function main() {
  const results = [];
  for (const ref of refs) {
    results.push(await profile(ref));
  }
  console.log(JSON.stringify({ production_url: PROD, results }, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
