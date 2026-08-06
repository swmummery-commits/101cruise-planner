#!/usr/bin/env node
/**
 * Controlled Base44 booking document backfill (production-safe batches).
 *
 *   node scripts/run-booking-document-backfill.mjs --dry-run
 *   node scripts/run-booking-document-backfill.mjs --apply --batch-size 20
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BASE44_BOOKING_FUNCTION_URL, BASE44_API_KEY
 */

import { execSync } from "child_process";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
createSupabaseRest(root);

const { fetchBase44Booking, cacheBookingInSupabase, supabaseRest } = require(
  path.join(root, "netlify/functions/booking-service.js")
);
const { syncBookingDocuments } = require(path.join(root, "netlify/functions/lib/booking-document-sync.js"));

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const dryRun = !apply || args.has("--dry-run");
const useNetlifyEnv = args.has("--use-netlify-env");
const batchSize = Math.min(Math.max(Number(process.env.BATCH_SIZE || 20), 1), 50);
const startCursor = Math.max(Number(process.env.CURSOR || 0), 0);
const maxBatches = Math.max(Number(process.env.MAX_BATCHES || 9999), 1);

function loadNetlifyEnv(name) {
  const netlifyBin =
    process.env.NETLIFY_CLI_BIN ||
    "/Users/stevemummery/.npm/_npx/5897f426ba328dd1/node_modules/.bin/netlify";
  const raw = execSync(`${netlifyBin} env:get ${name} --context production`, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 240000
  });
  const lines = raw
    .split("\n")
    .map((line) => line.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
    .filter((line) => !line.startsWith("npm warn"));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const value = lines[i];
    if (value && !/No value set/i.test(value)) return value;
  }
  return "";
}

function ensureEnv(name) {
  if (process.env[name]) return process.env[name];
  if (useNetlifyEnv) {
    const value = loadNetlifyEnv(name);
    if (value) process.env[name] = value;
  }
  if (!process.env[name]) throw new Error(`${name} is required`);
  return process.env[name];
}

function isEligibleBooking(row) {
  const payload = row.raw_payload || {};
  const status = String(payload.booking_status || row.booking_status || "").toLowerCase();
  if (status.includes("cancel")) return false;
  const departing = payload.departing_date || row.departing_date;
  if (departing) {
    const departDate = new Date(departing);
    if (!Number.isNaN(departDate.getTime())) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 30);
      if (departDate >= cutoff) return true;
    }
  }
  const lastSynced = row.last_synced_at ? new Date(row.last_synced_at) : null;
  if (lastSynced && !Number.isNaN(lastSynced.getTime())) {
    const recent = new Date();
    recent.setDate(recent.getDate() - 14);
    if (lastSynced >= recent) return true;
  }
  return Boolean(Array.isArray(payload.documents) && payload.documents.length);
}

async function runBatch(cursor) {
  const cacheRows = await supabaseRest(
    `base44_booking_cache?select=base44_booking_id,booking_reference,raw_payload,last_synced_at&order=booking_reference.asc&limit=${batchSize}&offset=${cursor}`,
    { method: "GET" }
  );

  const batch = {
    cursor,
    batch_size: batchSize,
    bookings_scanned: (cacheRows || []).length,
    bookings_processed: 0,
    documents: { discovered: 0, inserted: 0, updated: 0, unchanged: 0, archived: 0, failed: 0, skipped_conflict: 0 },
    errors: [],
    next_cursor: cursor + batchSize,
    has_more: (cacheRows || []).length === batchSize
  };

  for (const cacheRow of (cacheRows || []).filter(isEligibleBooking)) {
    batch.bookings_processed += 1;
    try {
      let booking;
      let source;
      ({ booking, source } = await fetchBase44Booking({
        booking_reference: cacheRow.booking_reference,
        booking_id: cacheRow.base44_booking_id
      }));

      const docs = Array.isArray(source?.documents)
        ? source.documents
        : Array.isArray(booking?.documents)
          ? booking.documents
          : [];
      batch.documents.discovered += docs.length;

      if (dryRun) continue;

      await cacheBookingInSupabase(booking);
      const syncResult = await syncBookingDocuments(supabaseRest, booking, source, { completeFetch: true });
      batch.documents.inserted += syncResult.inserted || 0;
      batch.documents.updated += syncResult.updated || 0;
      batch.documents.unchanged += syncResult.unchanged || 0;
      batch.documents.archived += syncResult.archived || 0;
      batch.documents.failed += syncResult.failed || 0;
      batch.documents.skipped_conflict = (batch.documents.skipped_conflict || 0) + (syncResult.skipped_conflict || 0);
      if (syncResult.errors?.length) {
        batch.errors.push(
          ...syncResult.errors.slice(0, 3).map((entry) => ({
            booking_reference: cacheRow.booking_reference,
            ...entry
          }))
        );
      }
    } catch (error) {
      batch.errors.push({
        booking_reference: cacheRow.booking_reference,
        message: error.message || String(error)
      });
    }
  }

  return batch;
}

async function main() {
  ensureEnv("SUPABASE_URL");
  ensureEnv("SUPABASE_SERVICE_ROLE_KEY");
  ensureEnv("BASE44_BOOKING_FUNCTION_URL");
  ensureEnv("BASE44_API_KEY");

  const totals = {
    mode: dryRun ? "dry-run" : "apply",
    batches: [],
    documents: { discovered: 0, inserted: 0, updated: 0, unchanged: 0, archived: 0, failed: 0, skipped_conflict: 0 },
    bookings_processed: 0
  };

  let cursor = startCursor;
  for (let i = 0; i < maxBatches; i += 1) {
    const batch = await runBatch(cursor);
    totals.batches.push(batch);
    totals.bookings_processed += batch.bookings_processed;
    for (const key of Object.keys(totals.documents)) {
      totals.documents[key] += batch.documents[key] || 0;
    }
    if (!batch.has_more) break;
    cursor = batch.next_cursor;
  }

  console.log(JSON.stringify(totals, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
