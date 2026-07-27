#!/usr/bin/env node
/**
 * One-shot text itinerary extraction for a booking reference.
 *
 * Usage:
 *   node scripts/extract-text-itinerary-once.mjs CD5Q25
 *
 * Requires .env SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (Original only).
 * Refuses DEV host vkheexbapykcdfbqcach.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const { processTextItinerary } = require("../netlify/functions/lib/text-itinerary-process.js");

function die(message) {
  console.error(`\nERROR: ${message}\n`);
  process.exit(1);
}

function loadEnvFile() {
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) die(".env file not found");
  const env = {};
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

function makeRest(env) {
  const url = env.SUPABASE_URL.replace(/\/$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  return async (pathPart, options = {}) => {
    const headers = {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      ...(options.headers || {})
    };
    if (options.body !== undefined && options.body !== null) {
      headers["Content-Type"] = "application/json";
    }
    const response = await fetch(`${url}/rest/v1/${pathPart}`, {
      ...options,
      headers
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!response.ok) {
      throw new Error((data && data.message) || `Supabase HTTP ${response.status}`);
    }
    return data;
  };
}

const bookingReference = String(process.argv[2] || "")
  .trim()
  .toUpperCase();
if (!bookingReference) die("Usage: node scripts/extract-text-itinerary-once.mjs <BOOKING_REFERENCE>");

const env = loadEnvFile();
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  die("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in .env");
}
if (/vkheexbapykcdfbqcach/i.test(env.SUPABASE_URL)) {
  die("REFUSED: DEV Supabase project URL detected (vkheexbapykcdfbqcach)");
}

const rest = makeRest(env);

const cacheRows = await rest(
  `base44_booking_cache?booking_reference=eq.${encodeURIComponent(bookingReference)}&select=base44_booking_id,booking_reference,cruise_line,cruise_ship,departing_date,arriving_date,departing_port,arriving_port&limit=1`
);
const cached = Array.isArray(cacheRows) ? cacheRows[0] : null;
if (!cached?.base44_booking_id) {
  die(`Booking ${bookingReference} not found in base44_booking_cache`);
}

const docRows = await rest(
  `booking_documents?booking_reference=eq.${encodeURIComponent(bookingReference)}&document_type=ilike.*booking*confirmation*&select=*&order=uploaded_at.desc&limit=5`
);
const documents = Array.isArray(docRows) ? docRows : [];
const document = documents.find((row) => row.file_url) || null;
if (!document) {
  die(`No Booking Confirmation document with file_url found for ${bookingReference}`);
}

const booking = {
  base44_booking_id: cached.base44_booking_id,
  booking_reference: cached.booking_reference || bookingReference,
  cruise_line: cached.cruise_line,
  cruise_ship: cached.cruise_ship,
  departing_date: cached.departing_date,
  arriving_date: cached.arriving_date,
  departing_port: cached.departing_port,
  arriving_port: cached.arriving_port
};

console.log(`Extracting text itinerary for ${bookingReference}…`);

const result = await processTextItinerary({
  rest,
  booking,
  document,
  supabaseUrl: env.SUPABASE_URL,
  openaiKey: process.env.OPENAI_API_KEY || env.OPENAI_API_KEY
});

console.log(
  JSON.stringify(
    {
      booking_reference: bookingReference,
      reason: result.reason,
      skipped: result.skipped || false,
      extraction_calls: result.extraction_calls,
      stop_count: result.stop_count ?? result.itinerary?.stops?.length ?? 0,
      stops: result.itinerary?.stops || []
    },
    null,
    2
  )
);

if (!result.ok && !result.skipped) {
  process.exit(1);
}
