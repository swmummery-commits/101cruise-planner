#!/usr/bin/env node
/**
 * Backfill Princess discovered_cruises.itinerary from official resdb marketing names.
 *
 *   node scripts/backfill-princess-itinerary-names.mjs            # dry-run (default)
 *   node scripts/backfill-princess-itinerary-names.mjs --apply
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const {
  bootstrapPrincessSession,
  fetchPrincessResdbCatalogue,
  buildPrincessItineraryNameMap,
  isPrincessVoyageCode
} = require(path.join(root, "netlify/functions/lib/princess-discovery-source"));
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const PRINCESS_LINE_ID = "c19f40a7-c160-4035-a845-14dada550e1f";
const PAGE_SIZE = 500;

function parseArgs(argv) {
  return { apply: argv.includes("--apply") };
}

async function fetchItineraryNameMap() {
  const session = await bootstrapPrincessSession();
  if (!session.ok) throw new Error(session.error || "princess_session_failed");

  const sessionCtx = {
    clientId: session.clientId,
    cookie: session.cookie,
    productCompany: session.productCompany,
    bookingCompany: session.bookingCompany
  };

  const catalogue = await fetchPrincessResdbCatalogue({
    session: sessionCtx,
    cruiseType: "C",
    light: false
  });
  if (!catalogue.ok) throw new Error(catalogue.error || "princess_names_fetch_failed");

  return buildPrincessItineraryNameMap(catalogue.products);
}

async function loadPrincessCruises(sb) {
  const rows = [];
  let offset = 0;
  while (true) {
    const batch = await sb.get(
      `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(PRINCESS_LINE_ID)}` +
        `&status=eq.active` +
        `&select=id,itinerary,raw_extract,official_sailing_id` +
        `&order=id.asc&limit=${PAGE_SIZE}&offset=${offset}`
    );
    if (!batch?.length) break;
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

function resolveItineraryId(row) {
  const extract =
    row.raw_extract && typeof row.raw_extract === "object" ? row.raw_extract : {};
  if (extract.princess_itinerary_id) return String(extract.princess_itinerary_id).trim();
  const sailingId = String(row.official_sailing_id || "").trim();
  if (sailingId.includes("|")) return sailingId.split("|")[0];
  if (isPrincessVoyageCode(row.itinerary)) return String(row.itinerary).trim();
  return null;
}

async function main() {
  const { apply } = parseArgs(process.argv);
  const sb = createSupabaseRest(root);

  const nameMap = await fetchItineraryNameMap();
  const cruises = await loadPrincessCruises(sb);

  const updates = [];
  const skipped = [];

  for (const row of cruises) {
    const current = String(row.itinerary || "").trim();
    if (!current) {
      skipped.push({ id: row.id, reason: "empty_itinerary" });
      continue;
    }
    if (!isPrincessVoyageCode(current)) {
      skipped.push({ id: row.id, reason: "already_named", itinerary: current });
      continue;
    }

    const itineraryId = resolveItineraryId(row);
    const nextName = itineraryId ? nameMap.get(itineraryId) : null;
    if (!nextName) {
      skipped.push({ id: row.id, reason: "name_not_found", itinerary_id: itineraryId });
      continue;
    }
    if (nextName === current) {
      skipped.push({ id: row.id, reason: "unchanged", itinerary: current });
      continue;
    }

    const extract =
      row.raw_extract && typeof row.raw_extract === "object" ? { ...row.raw_extract } : {};
    extract.princess_itinerary_id = itineraryId || extract.princess_itinerary_id || null;
    extract.princess_itinerary_name = nextName;
    extract.princess_itinerary_name_backfill_at = new Date().toISOString();

    updates.push({
      id: row.id,
      from: current,
      to: nextName,
      itinerary_id: itineraryId,
      payload: {
        itinerary: nextName,
        raw_extract: extract
      }
    });
  }

  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry_run",
        princess_active_rows: cruises.length,
        official_name_map_size: nameMap.size,
        updates: updates.length,
        skipped: skipped.length,
        sample_updates: updates.slice(0, 8).map((u) => ({
          id: u.id,
          from: u.from,
          to: u.to,
          itinerary_id: u.itinerary_id
        })),
        sample_skipped: skipped.slice(0, 5)
      },
      null,
      2
    )
  );

  if (!apply) {
    console.log("\nDry run only. Re-run with --apply to persist updates.");
    return;
  }

  let applied = 0;
  for (const update of updates) {
    await sb.patch(`discovered_cruises?id=eq.${encodeURIComponent(update.id)}`, update.payload);
    applied += 1;
  }

  console.log(`\nApplied ${applied} itinerary name updates.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
