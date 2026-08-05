#!/usr/bin/env node
/**
 * Link published destination research to Living Destination shells and publish them.
 *
 * Most destinations already have published research_content rows; shells were seeded
 * as draft without research_content_id. This script syncs them in one pass.
 *
 *   node scripts/sync-destination-shells-from-research.mjs --dry-run
 *   node scripts/sync-destination-shells-from-research.mjs --apply
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { OPERATIONAL_DESTINATION_CATALOGUE } = require(path.join(
  root,
  "netlify/functions/lib/destination-classification.js"
));

/** Destination shell slug → published research entity_key when they differ. */
const RESEARCH_KEY_BY_DESTINATION_SLUG = {
  "world-cruise": "world-cruises",
  asia: "south-east-asia",
  "european-river-cruises": "river-cruises",
  "mexican-riviera": "mexico"
};

/** Extra public pages: research exists but no destination shell yet. */
const EXTRA_DESTINATION_SHELLS = [
  {
    slug: "greek-islands",
    researchKey: "greek-islands",
    name: "Greek Islands",
    primary_region: "Europe"
  }
];

const AUS_NZ_OVERVIEW =
  "Australia and New Zealand cruising combines home-port convenience for Australian travellers with coastal cities, Tasman Sea crossings and New Zealand’s dramatic fjords and wine regions. Sailings typically run November through March, with Sydney, Brisbane, Melbourne and Auckland among the main embarkation points — ideal for first-time cruisers and families who want strong scenery without a long-haul flight before boarding.";

const PACIFIC_COAST_OVERVIEW =
  "Pacific Coast cruises trace the scenic shoreline from San Diego and Los Angeles through San Francisco, Seattle and Vancouver — a relaxed West Coast route of coastal cities, wine country and Pacific Northwest forests. It suits travellers who want shorter repositioning-style sailings, mild shoulder-season weather and easy city stops without crossing an ocean.";

function parseArgs(argv) {
  return { apply: argv.includes("--apply"), dryRun: !argv.includes("--apply") };
}

function catalogueMeta(slug) {
  return OPERATIONAL_DESTINATION_CATALOGUE.find((d) => d.slug === slug) || null;
}

function shellPayloadFromResearch(dest, research) {
  const payload = {
    status: "published",
    research_content_id: research.id,
    seo_title: research.seo_title || `${dest.name || research.entity_name} Cruises | 101cruise`,
    meta_description:
      research.meta_description ||
      String(research.summary_text || research.content_json?.overview || "")
        .trim()
        .slice(0, 160) ||
      null
  };
  if (!dest.hero_media_id && research.media_id) {
    payload.hero_media_id = research.media_id;
  }
  return payload;
}

function mergeAusNzContent(australia, newZealand) {
  const a = australia.content_json || {};
  const b = newZealand.content_json || {};
  const uniq = (arr) => [...new Set((arr || []).filter(Boolean))];
  return {
    schema_version: "1.1",
    entity_type: "destination",
    overview: AUS_NZ_OVERVIEW,
    why_visit: [a.why_visit, b.why_visit].filter(Boolean).join(" ").slice(0, 1200),
    best_time_to_visit: "November – March",
    climate_summary: "Warm summers along the coast; milder spring and autumn",
    cruise_length: "7 – 14 nights",
    departure_ports: "Sydney · Brisbane · Melbourne · Auckland",
    ideal_for: uniq([...(a.ideal_for || []), ...(b.ideal_for || [])]).slice(0, 8),
    key_highlights: uniq([...(a.key_highlights || []), ...(b.key_highlights || [])]).slice(0, 8),
    signature_experiences: uniq([...(a.signature_experiences || []), ...(b.signature_experiences || [])]).slice(0, 6),
    frequently_asked_questions: uniq([
      ...(a.frequently_asked_questions || []),
      ...(b.frequently_asked_questions || [])
    ]).slice(0, 6),
    research_notes: "Combined from published Australia and New Zealand research for the operational AU & NZ destination shell."
  };
}

async function loadPublishedResearchByKey(sb) {
  const rows = await sb.get(
    "research_content?entity_type=eq.destination&content_status=eq.published&select=id,entity_key,entity_name,summary_text,seo_title,meta_description,content_json,media_id,canonical_slug"
  );
  return Object.fromEntries(rows.map((r) => [r.entity_key, r]));
}

async function ensureAusNzResearch(sb, researchByKey, { dryRun }) {
  if (researchByKey["australia-new-zealand"]) {
    return researchByKey["australia-new-zealand"];
  }
  const australia = researchByKey.australia;
  const newZealand = researchByKey["new-zealand"];
  if (!australia || !newZealand) {
    throw new Error("Cannot build australia-new-zealand research — missing australia or new-zealand published rows");
  }
  const content_json = mergeAusNzContent(australia, newZealand);
  const row = {
    entity_type: "destination",
    entity_key: "australia-new-zealand",
    entity_name: "Australia and New Zealand",
    canonical_slug: "australia-new-zealand",
    content_status: "published",
    content_version: 1,
    content_json,
    summary_text: AUS_NZ_OVERVIEW.slice(0, 280),
    published_at: new Date().toISOString(),
    refresh_after: new Date(Date.now() + 18 * 30 * 24 * 60 * 60 * 1000).toISOString()
  };
  if (dryRun) {
    console.log("  [dry-run] would create published research: australia-new-zealand");
    const item = { ...row, id: "dry-run-aus-nz" };
    researchByKey["australia-new-zealand"] = item;
    return item;
  }
  const created = await sb.post("research_content", row, { prefer: "return=representation" });
  const item = Array.isArray(created) ? created[0] : created;
  researchByKey["australia-new-zealand"] = item;
  console.log("  created published research: australia-new-zealand");
  return item;
}

async function ensurePacificCoastResearch(sb, researchByKey, { dryRun }) {
  if (researchByKey["pacific-coast"]) {
    return researchByKey["pacific-coast"];
  }
  const cat = catalogueMeta("pacific-coast");
  const content_json = {
    schema_version: "1.1",
    entity_type: "destination",
    overview: PACIFIC_COAST_OVERVIEW,
    why_visit:
      "The Pacific Coast offers a manageable West Coast cruise without the commitment of a full ocean crossing — city skylines, coastal highways and Pacific Northwest scenery in one relaxed itinerary.",
    best_time_to_visit: "April – October",
    climate_summary: "Mild coastal; cooler and wetter in the Pacific Northwest",
    cruise_length: "5 – 10 nights",
    departure_ports: (cat?.representative_ports || ["San Diego", "Los Angeles", "San Francisco", "Seattle", "Vancouver"]).join(
      " · "
    ),
    ideal_for: ["Coastal scenery lovers", "First-time cruisers", "City and wine-country travellers"],
    key_highlights: ["California coastline", "San Francisco bay", "Pacific Northwest forests", "Wine regions"],
    research_notes: "Bootstrap editorial for operational Pacific Coast shell — refresh via Admin Research Content when ready."
  };
  const row = {
    entity_type: "destination",
    entity_key: "pacific-coast",
    entity_name: "Pacific Coast",
    canonical_slug: "pacific-coast",
    content_status: "published",
    content_version: 1,
    content_json,
    summary_text: PACIFIC_COAST_OVERVIEW.slice(0, 280),
    published_at: new Date().toISOString(),
    refresh_after: new Date(Date.now() + 18 * 30 * 24 * 60 * 60 * 1000).toISOString()
  };
  if (dryRun) {
    console.log("  [dry-run] would create published research: pacific-coast");
    const item = { ...row, id: "dry-run-pacific-coast" };
    researchByKey["pacific-coast"] = item;
    return item;
  }
  const created = await sb.post("research_content", row, { prefer: "return=representation" });
  const item = Array.isArray(created) ? created[0] : created;
  researchByKey["pacific-coast"] = item;
  console.log("  created published research: pacific-coast");
  return item;
}

async function main() {
  const { apply, dryRun } = parseArgs(process.argv);
  const sb = createSupabaseRest(root);
  const researchByKey = await loadPublishedResearchByKey(sb);

  await ensureAusNzResearch(sb, researchByKey, { dryRun });
  await ensurePacificCoastResearch(sb, researchByKey, { dryRun });

  const destinations = await sb.get(
    "destinations?select=id,slug,name,status,research_content_id,hero_media_id,primary_region&order=slug.asc"
  );

  const results = { published: [], skipped: [], created: [], errors: [] };

  for (const dest of destinations) {
    if (dest.status === "published" && dest.research_content_id) {
      results.skipped.push(`${dest.slug} (already published)`);
      continue;
    }
    const researchKey = RESEARCH_KEY_BY_DESTINATION_SLUG[dest.slug] || dest.slug;
    const research = researchByKey[researchKey];
    if (!research) {
      results.errors.push(`${dest.slug}: no published research for key "${researchKey}"`);
      continue;
    }
    const payload = shellPayloadFromResearch(dest, research);
    if (dryRun) {
      console.log(`  [dry-run] would publish ${dest.slug} ← research ${researchKey}`);
      results.published.push(dest.slug);
      continue;
    }
    await sb.patch(`destinations?id=eq.${encodeURIComponent(dest.id)}`, payload);
    console.log(`  published shell: ${dest.slug} ← research ${researchKey}`);
    results.published.push(dest.slug);
  }

  for (const extra of EXTRA_DESTINATION_SHELLS) {
    const existing = destinations.find((d) => d.slug === extra.slug);
    const research = researchByKey[extra.researchKey];
    if (!research) {
      results.errors.push(`${extra.slug}: no published research for key "${extra.researchKey}"`);
      continue;
    }
    if (existing) {
      if (existing.status !== "published" || !existing.research_content_id) {
        const payload = shellPayloadFromResearch(existing, research);
        if (dryRun) {
          console.log(`  [dry-run] would publish existing shell ${extra.slug}`);
        } else {
          await sb.patch(`destinations?id=eq.${encodeURIComponent(existing.id)}`, payload);
          console.log(`  published existing shell: ${extra.slug}`);
        }
        results.published.push(extra.slug);
      }
      continue;
    }
    const payload = {
      name: extra.name,
      slug: extra.slug,
      primary_region: extra.primary_region || null,
      display_order: 100,
      ...shellPayloadFromResearch({ name: extra.name, hero_media_id: null }, research)
    };
    if (dryRun) {
      console.log(`  [dry-run] would create and publish shell ${extra.slug}`);
      results.created.push(extra.slug);
      continue;
    }
    await sb.post("destinations", payload, { prefer: "return=representation" });
    console.log(`  created and published shell: ${extra.slug}`);
    results.created.push(extra.slug);
  }

  console.log("\nSummary:");
  console.log(`  mode: ${dryRun ? "dry-run" : "apply"}`);
  console.log(`  published shells: ${results.published.length}`, results.published.join(", ") || "—");
  console.log(`  created shells: ${results.created.length}`, results.created.join(", ") || "—");
  console.log(`  skipped: ${results.skipped.length}`, results.skipped.join(", ") || "—");
  if (results.errors.length) {
    console.error(`  errors: ${results.errors.length}`);
    for (const e of results.errors) console.error(`    - ${e}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
