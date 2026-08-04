#!/usr/bin/env node
/**
 * Generate operational destination seed manifest and eight-cruise correction manifest.
 * READ ONLY — no DB writes.
 *
 *   node scripts/generate-destination-manifests.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { OPERATIONAL_DESTINATION_CATALOGUE } = require(
  path.join(root, "netlify/functions/lib/destination-classification")
);
const { resolveOperationalDestination } = require(
  path.join(root, "netlify/functions/lib/discovery-destination-resolver")
);
const { loadPortsCatalogue } = require(path.join(root, "netlify/functions/lib/discovery-departure-port"));
const { PORT_DESTINATION_HINTS } = require(
  path.join(root, "netlify/functions/lib/destination-port-mappings")
);

const ALASKA_ID = "c8eb51fa-aeca-4d93-9bd9-bfe8ce66a83c";

function parseArrivalFromTitle(title) {
  const t = String(title || "");
  const m = t.match(/\bto\s+([^|]+?)(?:\s*\||\s+on\s|\s*$)/i);
  return m ? m[1].replace(/\([^)]*\)/g, "").trim() : null;
}

function parseDepartureFromTitle(title) {
  const t = String(title || "");
  const m = t.match(/(?:^|[\s-])([A-Za-z\s]+?)\s+to\s+/i);
  return m ? m[1].trim() : null;
}

function parseRouteEndpoints(title, description) {
  const t = String(title || "");
  const crystalPipe = t.match(/\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/);
  if (crystalPipe) {
    const routePart = crystalPipe[2].trim();
    const routeMatch = routePart.match(/([A-Za-z][A-Za-z\s]{2,25}?)\s+to\s+([A-Za-z][A-Za-z\s]{2,25})/i);
    if (routeMatch) {
      return {
        departure: routeMatch[1].replace(/\([^)]*\)/g, "").trim(),
        arrival: routeMatch[2].replace(/\([^)]*\)/g, "").trim()
      };
    }
  }
  const routeMatch = t.match(/([A-Za-z][A-Za-z\s]{2,30}?)\s+to\s+([A-Za-z][A-Za-z\s]{2,30}?)(?:\s*\||\s+on\s|\s*$)/i);
  if (routeMatch) {
    return {
      departure: routeMatch[1].replace(/\([^)]*\)/g, "").trim(),
      arrival: routeMatch[2].replace(/\([^)]*\)/g, "").trim()
    };
  }
  const descMatch = String(description || "").match(/([A-Za-z][A-Za-z\s]{2,30}?)\s+to\s+([A-Za-z][A-Za-z\s]{2,30})/i);
  if (descMatch) {
    return {
      departure: descMatch[1].trim(),
      arrival: descMatch[2].trim()
    };
  }
  return { departure: null, arrival: null };
}

function proposedOutcome(row, result, otherIssues) {
  if (row.id === "60f71bc7-af1f-429a-a4fa-85b3f6e0701c") {
    return otherIssues.includes("ship_guess_noise_from_url_slug")
      ? "operational_data_quality_investigation"
      : "operational_correction";
  }
  if (row.id === "857fc5e4-0c7a-41aa-8400-2df2a01611f0") {
    if (otherIssues.includes("departure_port_conflicts_with_title_route")) {
      return "operational_data_quality_investigation";
    }
  }
  if (result.status === "unresolved") return "operational_data_quality_investigation";
  if (result.status === "ambiguous") return "steve_review";
  return "operational_correction";
}

function reassessCruise(row, destinations) {
  const raw = row.raw_extract || {};
  const title = raw.title || "";
  const description = raw.description || "";
  const route = parseRouteEndpoints(title, description);
  const arrival = route.arrival || parseArrivalFromTitle(title);
  let departurePort = row.departure_port || route.departure || parseDepartureFromTitle(title);
  let arrivalPort = arrival;

  if (row.id === "857fc5e4-0c7a-41aa-8400-2df2a01611f0" && route.departure && route.arrival) {
    departurePort = route.departure;
    arrivalPort = route.arrival;
  }

  const result = resolveOperationalDestination({
    title,
    description,
    itinerary: row.itinerary,
    departurePort,
    arrivalPort,
    nights: row.nights,
    destinations
  });
  const currentName = row.destinations?.name || "Alaska";
  const proposedName = result.destinationName || result.destinationKey || null;
  const alaskaCorrect =
    result.destinationKey === "alaska" || result.destinationName === "Alaska";
  const currentlyAlaska = currentName === "Alaska";
  let alaskaAssignmentCorrect = currentlyAlaska && alaskaCorrect;
  if (currentlyAlaska && !alaskaCorrect) alaskaAssignmentCorrect = false;
  if (!currentlyAlaska && alaskaCorrect) alaskaAssignmentCorrect = true;

  const otherIssues = [];
  if (row.id === "60f71bc7-af1f-429a-a4fa-85b3f6e0701c") {
    if (!row.departure_port && !route.departure) otherIssues.push("missing_departure_port");
    otherIssues.push("ship_guess_noise_from_url_slug");
    otherIssues.push("voyage_identity_mismatch_crystal_symphony_vs_serenity");
  }
  if (row.id === "857fc5e4-0c7a-41aa-8400-2df2a01611f0") {
    if (title.toLowerCase().includes("seward") && row.departure_port === "Tokyo") {
      otherIssues.push("departure_port_conflicts_with_title_route");
    }
  }
  if (raw.ship_name_guesses?.some((g) => /none csy|none cse/.test(g))) {
    otherIssues.push("ship_guess_noise_from_url_slug");
  }

  return {
    discovered_cruise_id: row.id,
    cruise_line: row.ci_cruise_lines?.name,
    ship: row.ci_cruise_ships?.name,
    departure_date: row.departure_date,
    departure_port: departurePort,
    arrival_port: arrivalPort,
    duration_nights: row.nights,
    source_url: row.official_url,
    itinerary_ports: row.itinerary,
    current_destination_id: row.destination_id,
    current_destination_name: currentName,
    proposed_destination_key: result.destinationKey,
    proposed_destination_name: proposedName,
    proposed_destination_id: result.destinationId,
    proposed_outcome: proposedOutcome(row, result, otherIssues),
    confidence: result.confidence,
    status: result.status,
    evidence_summary: result.evidence?.slice(0, 6),
    alaska_assignment_correct: alaskaAssignmentCorrect,
    source_record_valid: otherIssues.length === 0,
    other_issues: otherIssues,
    rollback_destination_id: row.destination_id,
    rollback_destination_name: currentName
  };
}

async function main() {
  const sb = createSupabaseRest(root);
  const today = new Date().toISOString().slice(0, 10);
  const [destRows, cruises] = await Promise.all([
    sb.get("destinations?select=id,name,slug,status,primary_region&order=name.asc"),
    sb.get(
      `discovered_cruises?status=eq.active&or=(departure_date.is.null,departure_date.gte.${today})&select=id,departure_date,return_date,nights,departure_port,itinerary,official_url,destination_id,raw_extract,destinations!discovered_cruises_destination_id_fkey(name,slug),ci_cruise_lines(name),ci_cruise_ships(name)&order=departure_date.asc`
    )
  ]);

  const destinations = destRows || [];
  const seedEntries = OPERATIONAL_DESTINATION_CATALOGUE.map((cat) => {
    const existing = destinations.find((d) => d.slug === cat.slug);
    return {
      proposed_key: cat.key,
      canonical_name: cat.name,
      slug: cat.slug,
      classification_enabled: cat.classification_enabled,
      public_status: cat.public_status,
      primary_region: cat.primary_region,
      parent_region: cat.parent_region,
      aliases: cat.aliases,
      representative_ports: cat.representative_ports,
      route_signals: cat.route_signals,
      display_order: 100,
      proposed_id_strategy: existing ? "use_existing_row" : "insert_new_uuid",
      existing_id: existing?.id || null,
      before_state: existing
        ? { id: existing.id, status: existing.status, name: existing.name }
        : null,
      rollback_action: existing ? "no_change" : "delete_inserted_row",
      cruise_finder_immediate: cat.cruise_finder_immediate,
      living_destination_editorial_required: cat.living_destination_required
    };
  });

  const seedManifest = {
    generated_at: new Date().toISOString(),
    mode: "operational_destination_seed",
    writes_performed: false,
    migration_required: "supabase/migrations/20260802_destination_classification.sql",
    entry_count: seedEntries.length,
    entries: seedEntries
  };

  const corrections = (cruises || []).map((row) => reassessCruise(row, destinations));
  const correctionManifest = {
    generated_at: new Date().toISOString(),
    mode: "destination_correction_dry_run",
    writes_performed: false,
    alaska_id: ALASKA_ID,
    summary: {
      total: corrections.length,
      correctly_tagged_alaska: corrections.filter((c) => c.alaska_assignment_correct && c.current_destination_name === "Alaska" && c.proposed_destination_key === "alaska").length,
      incorrectly_tagged_alaska: corrections.filter((c) => c.current_destination_name === "Alaska" && c.proposed_destination_key !== "alaska").length,
      needs_correction: corrections.filter((c) => c.current_destination_id !== c.proposed_destination_id && c.proposed_destination_key).length
    },
    entries: corrections
  };

  const ports = loadPortsCatalogue();
  const mappedPorts = Object.keys(PORT_DESTINATION_HINTS).length;
  const portAudit = {
    total_canonical_ports: ports.length,
    ports_with_destination_hints: mappedPorts,
    ports_without_mapping: ports.length - mappedPorts,
    high_value_unmapped_sample: ports
      .filter((p) => !PORT_DESTINATION_HINTS[normalisePort(p.canonical_name)])
      .slice(0, 20)
      .map((p) => p.canonical_name)
  };

  function normalisePort(n) {
    return String(n || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .trim();
  }

  for (const p of ports) {
    const key = normalisePort(p.canonical_name);
    if (PORT_DESTINATION_HINTS[key]) continue;
  }

  fs.mkdirSync(path.join(root, "reports"), { recursive: true });
  const seedPath = path.join(root, "reports/operational-destination-seed-manifest.json");
  const correctionPath = path.join(root, "reports/destination-correction-manifest.json");
  const portPath = path.join(root, "reports/destination-port-mapping-audit.json");
  fs.writeFileSync(seedPath, JSON.stringify(seedManifest, null, 2));
  fs.writeFileSync(correctionPath, JSON.stringify(correctionManifest, null, 2));
  fs.writeFileSync(portPath, JSON.stringify(portAudit, null, 2));

  console.log("Seed manifest:", seedPath, `(${seedEntries.length} destinations)`);
  console.log("Correction manifest:", correctionPath);
  console.log("Port audit:", portPath);
  console.log(JSON.stringify(correctionManifest.summary, null, 2));
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
