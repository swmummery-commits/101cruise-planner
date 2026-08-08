#!/usr/bin/env node
/**
 * Audit all public port images against current scoring rules (read-only).
 *
 *   node scripts/audit-public-port-images.mjs
 *   node scripts/audit-public-port-images.mjs --json reports/public-port-image-audit.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { findPortImageCandidates } = require(path.join(root, "netlify/functions/lib/port-image-finder/search.js"));
const {
  auditStoredPortImage,
  buildPublicAuditMetrics,
  summariseAuditRow
} = require(path.join(root, "netlify/functions/lib/port-image-finder/public-image-audit.js"));
const { resolveCatalogueMediaIds } = require(path.join(
  root,
  "netlify/functions/lib/port-image-finder/resolve-public.js"
));

const CIVIT_ID = "777a9a1d-55e2-4330-89d0-59ec08bca45d";
const PORT_SELECT =
  "id,canonical_name,display_name,city,country,country_code,region,aliases,hero_media_id,image_status,image_source,image_source_url,image_credit,image_license,image_search_query,image_confidence,image_last_checked_at";

const jsonOut = process.argv.find((a) => a.startsWith("--json="))?.split("=")[1] ||
  (process.argv.includes("--json") ? "reports/public-port-image-audit.json" : null);

async function loadMediaMap(rest, mediaIds) {
  const map = new Map();
  for (const id of mediaIds) {
    const rows = await rest.get(
      `media_library?select=id,title,alt_text,public_url,source_url,width,height&id=eq.${encodeURIComponent(id)}&limit=1`
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    if (row) map.set(id, row);
  }
  return map;
}

async function main() {
  const rest = createSupabaseRest(root);
  const ports = await rest.get(`ports?select=${encodeURIComponent(PORT_SELECT)}&limit=2000`);
  const all = Array.isArray(ports) ? ports : [];

  const publicPorts = all.filter(
    (p) =>
      p.hero_media_id &&
      ["AUTO_APPROVED", "MANUAL"].includes(String(p.image_status || "").toUpperCase())
  );
  const needsReviewPorts = all.filter((p) => String(p.image_status || "").toUpperCase() === "NEEDS_REVIEW");
  const noImagePorts = all.filter(
    (p) => !p.hero_media_id || ["NO_IMAGE", null, ""].includes(String(p.image_status || "").toUpperCase())
  );

  const mediaIds = [...new Set(publicPorts.map((p) => p.hero_media_id).filter(Boolean))];
  const mediaMap = await loadMediaMap(rest, mediaIds);

  const audits = publicPorts.map((port) =>
    auditStoredPortImage(port, mediaMap.get(port.hero_media_id) || null)
  );

  const metrics = buildPublicAuditMetrics(audits, { needsReviewPorts, noImagePorts });

  const needsReviewDetail = [];
  for (const port of needsReviewPorts) {
    const media = port.hero_media_id ? mediaMap.get(port.hero_media_id) || (await rest.get(
      `media_library?select=id,title,alt_text,public_url,source_url,width,height&id=eq.${encodeURIComponent(port.hero_media_id)}&limit=1`
    ))[0] : null;
    if (port.hero_media_id && !mediaMap.has(port.hero_media_id) && media) mediaMap.set(port.hero_media_id, media);
    const audit = auditStoredPortImage(port, media || null);
    needsReviewDetail.push({
      port: port.canonical_name,
      port_id: port.id,
      image: audit.current_image,
      source: port.image_source,
      licence: port.image_license,
      scores: audit.scores,
      editorial: audit.editorial
    });
  }

  let costaMaya = all.find((p) => /^costa maya$/i.test(p.canonical_name));
  let costaMayaSearch = null;
  if (costaMaya) {
    try {
      const search = await findPortImageCandidates(costaMaya, { force: true, autoApply: false });
      costaMayaSearch = {
        eligible: Boolean(search.eligibleCandidate),
        candidate: search.eligibleCandidate?.title || search.rawTopCandidate?.title || null,
        suggested_status: search.suggestedStatus
      };
    } catch (error) {
      costaMayaSearch = { error: error.message };
    }
  }

  const civit = all.find((p) => p.id === CIVIT_ID);
  const mykonos = all.find((p) => /^mykonos$/i.test(p.canonical_name));

  const table = audits.map((row) => ({
    Port: row.canonical_name,
    "Current image": row.current_image,
    Status: row.image_status,
    "Current rating": row.editorial,
    Action: row.action,
    Reasons: row.reasons.join("; ") || "—"
  }));

  const report = {
    generated_at: new Date().toISOString(),
    metrics,
    table,
    exceptions: metrics.exceptions,
    needsReview: needsReviewDetail,
    manualProtection: {
      civitavecchia: civit
        ? { id: civit.id, hero_media_id: civit.hero_media_id, image_status: civit.image_status, unchanged: true }
        : null,
      mykonos: mykonos
        ? { id: mykonos.id, hero_media_id: mykonos.hero_media_id, image_status: mykonos.image_status, unchanged: true }
        : null
    },
    costaMaya: costaMaya
      ? {
          canonical_name: costaMaya.canonical_name,
          image_status: costaMaya.image_status || "NO_IMAGE",
          search: costaMayaSearch,
          note: costaMayaSearch?.eligible ? "candidate_available_not_applied" : "NO_IMAGE - ACCEPTABLE"
        }
      : null,
    recommendation:
      metrics.replace === 0 &&
      metrics.wrongGeography === 0 &&
      metrics.licensingFailures === 0 &&
      metrics.militaryWar === 0 &&
      metrics.vesselPrimary === 0 &&
      metrics.currentPublicAutoApprovalQuality >= 95
        ? "SAFE FOR FULL MISSING-PORT ENRICHMENT"
        : "DO NOT RUN FULL MISSING-PORT ENRICHMENT YET"
  };

  console.log(JSON.stringify(report, null, 2));
  if (jsonOut) {
    fs.mkdirSync(path.dirname(path.join(root, jsonOut)), { recursive: true });
    fs.writeFileSync(path.join(root, jsonOut), JSON.stringify(report, null, 2));
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
