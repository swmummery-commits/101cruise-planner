#!/usr/bin/env node
/**
 * Narrow correction: restore distinct physical ports conflated during catalogue cleanup.
 *
 *   node scripts/ports-catalogue-physical-port-correction.mjs --dry-run
 *   node scripts/ports-catalogue-physical-port-correction.mjs --apply
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

const SEVILLE_ID = "3b3244bc-2a86-46a5-b93d-302646a03761";
const BANGKOK_PORT_ID = "bf65bd8b-ce3d-4507-bfcc-a13c5ff2efb2";
const CADIZ_ID = "762f0f0d-1efd-4a6e-9fb3-4afc68e104a0";
const LAEM_CHABANG_ID = "6fff4757-cbc5-480a-b776-cebf75d11966";
const HCMC_ID = "26c80a9c-d3ec-47fe-8c12-24f5ec388677";
const SEVILLE_STOP = "dec87f1d-5fd5-4b63-a337-da4b3c9f5199";
const BANGKOK_STOP = "b120d856-e6a9-4edf-b123-bbd87c589ba0";

async function patch(rest, id, body) {
  if (!APPLY) return body;
  return rest.request(`ports?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
    prefer: "return=representation"
  });
}

async function insert(rest, body) {
  if (!APPLY) return body;
  return rest.request("ports", { method: "POST", body, prefer: "return=representation" });
}

async function patchStop(rest, id, portId) {
  if (!APPLY) return { id, port_id: portId };
  await rest.request(`featured_cruise_itinerary_stops?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { port_id: portId },
    prefer: "return=minimal"
  });
  return { id, port_id: portId };
}

async function main() {
  const rest = createSupabaseRest(root);
  const report = { mode: APPLY ? "apply" : "dry-run", steps: [] };

  const sevilleExists = (await rest.get(`ports?select=id&canonical_name=eq.Seville&limit=1`))[0];
  if (!sevilleExists) {
    const seville = {
      id: SEVILLE_ID,
      canonical_name: "Seville",
      display_name: "Seville, Spain",
      city: "Seville",
      country: "Spain",
      country_code: "ES",
      region: "Andalusia",
      latitude: 37.3585,
      longitude: -6.025,
      aliases: ["Sevilla"],
      status: "verified",
      match_key: "seville|spain",
      hero_media_id: null,
      image_status: "NO_IMAGE"
    };
    await insert(rest, seville);
    report.steps.push({
      action: "restore_seville",
      record: seville,
      note: "Itinerary faaf7bdb lists Seville, Spain explicitly — not Cádiz gateway"
    });
  }

  await patch(rest, CADIZ_ID, { aliases: [] });
  report.steps.push({
    action: "cadiz_aliases_cleared",
    id: CADIZ_ID,
    aliases: [],
    note: "Seville is a separate physical port; no cross-alias"
  });

  await patchStop(rest, SEVILLE_STOP, SEVILLE_ID);
  report.steps.push({
    action: "repoint_seville_stop",
    stop_id: SEVILLE_STOP,
    port_id: SEVILLE_ID,
    entered_port_text: "Seville, Spain"
  });

  const bangkokExists = (await rest.get(`ports?select=id&canonical_name=eq.Bangkok%20Port&limit=1`))[0];
  if (!bangkokExists) {
    const bangkokPort = {
      id: BANGKOK_PORT_ID,
      canonical_name: "Bangkok Port",
      display_name: "Bangkok Port (Khlong Toei), Thailand",
      city: "Khlong Toei",
      country: "Thailand",
      country_code: "TH",
      region: "Southeast Asia",
      latitude: 13.7035,
      longitude: 100.584,
      aliases: ["Khlong Toei", "Bangkok Port Khlong Toei"],
      status: "verified",
      match_key: "bangkok port|thailand",
      hero_media_id: "85f892cb-8563-4677-954e-fa00646af923",
      image_status: "AUTO_APPROVED"
    };
    await insert(rest, bangkokPort);
    report.steps.push({
      action: "restore_bangkok_port",
      record: bangkokPort,
      note: "Original featured stop port_id was Bangkok/Khlong Toei before cleanup migration"
    });
  }

  await patch(rest, LAEM_CHABANG_ID, {
    aliases: [],
    display_name: "Laem Chabang (Bangkok), Thailand"
  });
  report.steps.push({
    action: "laem_chabang_aliases_cleared",
    id: LAEM_CHABANG_ID,
    aliases: [],
    note: "Customer-facing Bangkok kept in display_name only"
  });

  await patchStop(rest, BANGKOK_STOP, BANGKOK_PORT_ID);
  report.steps.push({
    action: "repoint_bangkok_stop",
    stop_id: BANGKOK_STOP,
    port_id: BANGKOK_PORT_ID,
    entered_port_text: "Bangkok, Thailand",
    note: "Restored to Khlong Toei record that existed before erroneous Laem Chabang merge"
  });

  const chanMayExists = (await rest.get(`ports?select=id&canonical_name=eq.Chan%20May&limit=1`))[0];
  if (!chanMayExists) {
    const chanMay = {
      canonical_name: "Chan May",
      display_name: "Chan May (Hue), Vietnam",
      city: "Chan May",
      country: "Vietnam",
      country_code: "VN",
      region: "Southeast Asia",
      latitude: 16.333444,
      longitude: 108.013667,
      aliases: ["Chan May Port"],
      status: "verified",
      match_key: "chan may|vietnam",
      hero_media_id: null,
      image_status: "NO_IMAGE"
    };
    const created = await insert(rest, chanMay);
    report.steps.push({ action: "create_chan_may", record: chanMay, created });
  }

  const hcmcBefore = (await rest.get(`ports?select=*&id=eq.${HCMC_ID}&limit=1`))[0];
  const phuMyPatch = {
    canonical_name: "Phu My",
    display_name: "Phu My (Ho Chi Minh City), Vietnam",
    city: "Phu My",
    country: "Vietnam",
    country_code: "VN",
    region: "Southeast Asia",
    latitude: 10.59,
    longitude: 107.01,
    aliases: ["Ho Chi Minh City", "Saigon", "Ho Chi Minh City Saigon"],
    match_key: "phu my|vietnam"
  };
  await patch(rest, HCMC_ID, phuMyPatch);
  report.steps.push({
    action: "rename_hcmc_to_phu_my",
    id: HCMC_ID,
    before: {
      canonical_name: hcmcBefore?.canonical_name,
      city: hcmcBefore?.city,
      latitude: hcmcBefore?.latitude,
      longitude: hcmcBefore?.longitude
    },
    after: phuMyPatch,
    references: 1,
    note: "Physical port is Phu My; HCMC remains customer-facing via display/aliases"
  });

  const aliasFixes = [
    {
      id: "5914e09c-4f2b-4534-ad64-32b3f75ffd7c",
      canonical_name: "Yokohama",
      body: { aliases: [], display_name: "Yokohama (Tokyo), Japan" }
    },
    {
      id: "7e7a0b4e-07b9-40b6-afa0-3e71746e4289",
      canonical_name: "Kobe",
      body: { aliases: ["Kyoto"], display_name: "Kobe (Kyoto), Japan" }
    },
    {
      id: "068205a5-4add-4c7c-902b-27a7398cc8a6",
      canonical_name: "Long Beach",
      body: { aliases: [], display_name: "Long Beach, California" }
    },
    {
      id: "07d4ae0f-55c4-4bbb-9b77-a64d75bc2fca",
      canonical_name: "Penang",
      body: { aliases: [], display_name: "Penang (George Town), Malaysia" }
    },
    {
      id: "062b5569-511e-4846-bbf5-7652a05e939e",
      canonical_name: "Los Angeles",
      body: { aliases: ["LA", "San Pedro"], display_name: "Los Angeles (San Pedro), USA" }
    }
  ];

  for (const fix of aliasFixes) {
    await patch(rest, fix.id, fix.body);
    report.steps.push({ action: "cross_alias_fix", ...fix });
  }

  await patch(rest, "7a72afc1-934b-47ad-896a-11ced05430d1", {
    country: "Indonesia",
    region: "Bali",
    country_code: "ID",
    match_key: "benoa|indonesia",
    display_name: "Benoa, Bali",
    aliases: ["Bali"]
  });
  report.steps.push({
    action: "benoa_geography",
    country: "Indonesia",
    region: "Bali",
    match_key: "benoa|indonesia"
  });

  await patch(rest, "c4e3861f-88b1-428c-9cd7-a0703cc0517d", {
    country: "United States",
    region: "Florida",
    country_code: "US",
    match_key: "miami|united states",
    display_name: "Miami, Florida"
  });
  report.steps.push({
    action: "miami_geography",
    country: "United States",
    region: "Florida",
    match_key: "miami|united states"
  });

  const out = path.join(root, "reports/ports-catalogue-physical-port-correction.json");
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`ports-catalogue-physical-port-correction: ${report.mode}`);
  console.log("Steps:", report.steps.length);
  console.log("Report:", out);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
