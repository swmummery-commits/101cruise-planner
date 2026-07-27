/**
 * Read-only audit of base44_booking_cache for contradictory fully-paid states.
 *
 * Usage:
 *   node scripts/audit-false-fully-paid.mjs
 *
 * Requires .env SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (Original only).
 * Does not modify any records. Does not print passenger PII.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const { isContradictoryFullyPaid, derivePaymentFields } = require("../js/base44-booking-field-contract.js");

function loadEnv() {
  const envPath = path.join(root, ".env");
  const env = {};
  if (!fs.existsSync(envPath)) throw new Error(".env not found");
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[m[1]] = v;
  }
  return env;
}

function money(v) {
  if (v == null) return null;
  if (typeof v === "string" && !v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function dateish(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, 10) : null;
}

const env = loadEnv();
if (/vkheexbapykcdfbqcach/i.test(env.SUPABASE_URL || "")) {
  throw new Error("REFUSED: DEV Supabase project");
}

const url = env.SUPABASE_URL.replace(/\/$/, "");
const key = env.SUPABASE_SERVICE_ROLE_KEY;

async function rest(pathPart) {
  const response = await fetch(`${url}/rest/v1/${pathPart}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json"
    }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.message || `HTTP ${response.status}`);
  return data;
}

const rows = [];
let offset = 0;
while (true) {
  const batch = await rest(
    `base44_booking_cache?select=booking_reference,raw_payload,last_synced_at&order=booking_reference.asc&limit=100&offset=${offset}`
  );
  if (!batch.length) break;
  rows.push(...batch);
  if (batch.length < 100) break;
  offset += 100;
}

const EPS = 0.02;
const flagged = [];
const receiptKeys = new Set();

for (const row of rows) {
  const p = row.raw_payload || {};
  for (const k of Object.keys(p)) {
    const lk = k.toLowerCase();
    if (lk.includes("received") || lk === "fully_paid_date" || lk === "final_payment_paid") {
      receiptKeys.add(k);
    }
  }

  const price = money(p.cruise_price_usd);
  const deposit = money(p.deposit_amount ?? p.cruise_deposit);
  const p2 = money(p.payment_2_amount ?? p.cruise_payment_2);
  const p3 = money(p.payment_3_amount ?? p.cruise_payment_3);
  const scheduled = (p2 && p2 > EPS ? p2 : 0) + (p3 && p3 > EPS ? p3 : 0);
  const depositDated = Boolean(dateish(p.deposit_paid_date || p.cruise_deposit_date));
  const confirmedReceived =
    depositDated && deposit != null ? deposit : money(p.amount_received) ?? deposit;
  const fully = dateish(p.fully_paid_date);
  const contradictory = isContradictoryFullyPaid(p);
  const status = String(p.payment_status || "")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const claims = Boolean(fully) || status === "fully_paid";

  if (!claims || scheduled <= EPS || !contradictory) continue;

  let category = "status_fully_paid_with_scheduled_instalment";
  const rawRecv = money(p.amount_received);
  if (fully && rawRecv != null && price != null && Math.abs(rawRecv - price) <= EPS) {
    category = "fully_paid_date_and_full_amount_received_with_scheduled_instalment";
  } else if (fully) {
    category = "fully_paid_date_with_scheduled_instalment";
  }

  flagged.push({
    booking_reference: row.booking_reference || p.booking_reference,
    cruise_price_usd: price,
    confirmed_amount_received: confirmedReceived,
    scheduled_outstanding_amount: scheduled,
    fully_paid_date: fully,
    discrepancy_category: category
  });
}

console.log(
  JSON.stringify(
    {
      cache_rows_scanned: rows.length,
      flagged_count: flagged.length,
      independent_receipt_fields_present: [...receiptKeys].sort(),
      flagged,
      note:
        "Audit covers cached CruiseBooking payloads only. Base44 entity automations are outside this repo."
    },
    null,
    2
  )
);

// Sanity: helper would correct CD5Q25 without mutating source entity semantics in-memory.
const cd5 = rows.find((r) => String(r.booking_reference).toUpperCase() === "CD5Q25");
if (cd5) {
  const fixed = derivePaymentFields(cd5.raw_payload || {});
  console.log(
    "cd5q25_in_memory_fix",
    JSON.stringify({
      amount_received: fixed.amount_received,
      balance_owing: fixed.balance_owing,
      payment_status: fixed.payment_status,
      fully_paid_date: fixed.fully_paid_date,
      final_payment_due_date: fixed.final_payment_due_date,
      final_payment_reminder_date: fixed.final_payment_reminder_date
    })
  );
}
