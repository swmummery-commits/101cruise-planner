#!/usr/bin/env node
/**
 * Apply high-confidence canonical ports catalogue integrity repairs.
 *
 *   node scripts/ports-catalogue-integrity-cleanup.mjs --dry-run
 *   node scripts/ports-catalogue-integrity-cleanup.mjs --apply
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const APPLY = process.argv.includes("--apply");
const DRY = !APPLY;

const CONSOLIDATIONS = [
  {
    remove_id: "50e16fa6-72ee-4194-a7d9-14e9c0b921e9",
    keep_id: "dfc9fc3d-2ed3-4713-89d2-55042b870cb7",
    reason: "Orlando is not a cruise port; Port Canaveral is the canonical berth"
  }
];

const DELETE_IDS = [
  {
    id: "0cdb0e4a-6ac2-421c-aef7-8f344e8a34d3",
    reason: "April 2028 is not a port (accidental admin/import garbage)"
  }
];

const GEO_FIXES = [
  {
    id: "96d097a0-24a8-4388-a463-307f14fed7f3",
    canonical_name: "Vancouver",
    patch: { region: "British Columbia" },
    reason: "Vancouver region was incorrectly Alaska"
  },
  {
    id: "58914173-9c3d-4d30-9ecb-c54ec21e54b5",
    canonical_name: "Da Nang",
    patch: { latitude: 16.114, longitude: 108.214 },
    reason: "Restore seed coordinates lost from catalogue row"
  }
];

const ALIAS_FIXES = [];

async function repointFeaturedStops(rest, fromId, toId) {
  const stops = await rest.get(
    `featured_cruise_itinerary_stops?select=id,port_id,entered_port_text&port_id=eq.${encodeURIComponent(fromId)}&limit=500`
  );
  const moved = [];
  for (const stop of stops || []) {
    moved.push({ stop_id: stop.id, entered_port_text: stop.entered_port_text });
    if (APPLY) {
      await rest.request(`featured_cruise_itinerary_stops?id=eq.${encodeURIComponent(stop.id)}`, {
        method: "PATCH",
        body: { port_id: toId },
        prefer: "return=minimal"
      });
    }
  }
  return moved;
}

async function verifyNoReferences(rest, portId) {
  const stops = await rest.get(
    `featured_cruise_itinerary_stops?select=id&port_id=eq.${encodeURIComponent(portId)}&limit=5`
  );
  return (stops || []).length;
}

async function loadPort(rest, id) {
  return (
    await rest.get(
      `ports?select=id,canonical_name,country,hero_media_id,image_status,aliases,match_key,region,latitude,longitude&id=eq.${encodeURIComponent(id)}&limit=1`
    )
  )[0] || null;
}

async function main() {
  const rest = createSupabaseRest(root);
  const report = {
    mode: DRY ? "dry-run" : "apply",
    started_at: new Date().toISOString(),
    consolidations: [],
    deletions: [],
    geo_fixes: [],
    alias_fixes: [],
    errors: []
  };

  for (const item of CONSOLIDATIONS) {
    const remove = await loadPort(rest, item.remove_id);
    const keep = await loadPort(rest, item.keep_id);
    if (!remove || !keep) {
      report.errors.push({ step: "consolidation", ...item, error: "missing port row" });
      continue;
    }
    const moved = await repointFeaturedStops(rest, item.remove_id, item.keep_id);
    const remaining = DRY ? moved.length : await verifyNoReferences(rest, item.remove_id);
    const step = {
      reason: item.reason,
      keep: {
        id: keep.id,
        canonical_name: keep.canonical_name,
        image_status: keep.image_status,
        hero_media_id: keep.hero_media_id
      },
      remove: {
        id: remove.id,
        canonical_name: remove.canonical_name,
        image_status: remove.image_status,
        hero_media_id: remove.hero_media_id
      },
      references_migrated: moved,
      references_remaining: remaining
    };
    if (remaining === 0 && APPLY) {
      await rest.request(`ports?id=eq.${encodeURIComponent(item.remove_id)}`, {
        method: "DELETE",
        prefer: "return=minimal"
      });
      step.removed = true;
    } else if (remaining === 0) {
      step.would_remove = true;
    }
    report.consolidations.push(step);
  }

  for (const item of DELETE_IDS) {
    const port = await loadPort(rest, item.id);
    if (!port) {
      report.deletions.push({ ...item, skipped: "already absent" });
      continue;
    }
    const refs = await verifyNoReferences(rest, item.id);
    const step = {
      reason: item.reason,
      port,
      references: refs
    };
    if (refs === 0 && APPLY) {
      await rest.request(`ports?id=eq.${encodeURIComponent(item.id)}`, {
        method: "DELETE",
        prefer: "return=minimal"
      });
      step.removed = true;
    } else if (refs === 0) {
      step.would_remove = true;
    }
    report.deletions.push(step);
  }

  for (const fix of GEO_FIXES) {
    const before = await loadPort(rest, fix.id);
    if (!before) {
      report.errors.push({ step: "geo", ...fix, error: "missing port row" });
      continue;
    }
    if (APPLY) {
      await rest.request(`ports?id=eq.${encodeURIComponent(fix.id)}`, {
        method: "PATCH",
        body: fix.patch,
        prefer: "return=representation"
      });
    }
    report.geo_fixes.push({
      canonical_name: fix.canonical_name,
      reason: fix.reason,
      before: {
        region: before.region,
        latitude: before.latitude,
        longitude: before.longitude
      },
      after: fix.patch
    });
  }

  for (const fix of ALIAS_FIXES) {
    const before = await loadPort(rest, fix.id);
    if (!before) continue;
    if (APPLY) {
      await rest.request(`ports?id=eq.${encodeURIComponent(fix.id)}`, {
        method: "PATCH",
        body: { aliases: fix.aliases },
        prefer: "return=representation"
      });
    }
    report.alias_fixes.push({
      canonical_name: fix.canonical_name,
      reason: fix.reason,
      before: before.aliases,
      after: fix.aliases
    });
  }

  const outPath = path.join(root, "reports/ports-catalogue-integrity-cleanup.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log(`ports-catalogue-integrity-cleanup: ${report.mode}`);
  console.log("Consolidations:", report.consolidations.length);
  console.log("Deletions:", report.deletions.length);
  console.log("Geo fixes:", report.geo_fixes.length);
  console.log("Alias fixes:", report.alias_fixes.length);
  console.log("Report:", outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
