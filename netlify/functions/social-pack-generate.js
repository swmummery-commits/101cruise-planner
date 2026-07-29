/**
 * Admin Social Pack Generator.
 *
 * Actions:
 *   preview        → one cruise, PNG data URLs + caption
 *   download_issue → ZIP of selected cruises
 *   readiness      → readiness list for an issue
 *
 * Never selects airline_price or category.
 * Never writes to the database or Media Library.
 */

const { requireAdmin } = require("./admin-auth");
const {
  loadFeaturedCruisePackModel,
  hydrateMedia,
  listIssueCruiseIds
} = require("./lib/social-pack-data");
const { renderCruisePack } = require("./lib/social-pack-render");
const { buildSocialPackZip } = require("./lib/social-pack-zip");

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

function zipResponse(buffer, filename) {
  return {
    statusCode: 200,
    isBase64Encoded: true,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store"
    },
    body: Buffer.from(buffer).toString("base64")
  };
}

function collectForbidden(model) {
  return [];
}

function normaliseTreatment(value) {
  const t = String(value || "soft").toLowerCase();
  return ["clear", "soft", "strong"].includes(t) ? t : "soft";
}

async function handlePreview(body) {
  const id = String(body.featured_cruise_id || "").trim();
  if (!id) {
    return jsonResponse(400, { success: false, error: "featured_cruise_id is required" });
  }
  const treatment = normaliseTreatment(body.treatment);
  const manualMediaId = body.social_media_id || body.manual_media_id || null;
  let model = await loadFeaturedCruisePackModel(id, {
    index: 1,
    treatment,
    manualMediaId
  });
  if (model.readiness?.status === "blocked") {
    return jsonResponse(400, {
      success: false,
      error: model.readiness.label,
      readiness: model.readiness
    });
  }
  model = await hydrateMedia(model);
  const rendered = await renderCruisePack(model, {
    forbiddenStrings: collectForbidden(model)
  });

  const slides = {};
  for (const [name, buf] of Object.entries(rendered.slides)) {
    slides[name] = `data:image/png;base64,${buf.toString("base64")}`;
  }

  return jsonResponse(200, {
    success: true,
    featured_cruise_id: model.id,
    folder_slug: model.folderSlug,
    readiness: model.readiness,
    caption: model.caption,
    warnings: model.readiness.warnings || [],
    treatment: model.treatment,
    background: {
      media_id: model.backgroundMediaId,
      title: model.backgroundTitle,
      destination_key: model.backgroundDestinationKey,
      match_role: model.backgroundMatchRole,
      candidate_count: model.backgroundCandidateCount,
      rotation_index: model.backgroundRotationIndex,
      source: model.backgroundSource,
      warning: model.backgroundWarning
    },
    picker_sections: model.pickerSections,
    background_candidates: model.backgroundCandidates,
    offers: (model.offers || []).map((o) => ({
      room_label: o.roomLabel,
      room_label_display: o.roomLabelDisplay,
      cruise_101_price: o.cruise101Price,
      brochure_price: o.brochurePrice,
      price_label: o.priceLabel
    })),
    offer: model.offer
      ? {
          room_label: model.offer.roomLabel,
          cruise_101_price: model.offer.cruise101Price,
          price_label: model.offer.priceLabel
        }
      : null,
    slides,
    slide_order: rendered.plan.map((p) => p.key),
    dimensions: rendered.dimensions,
    brand_logo_path: model.brandLogoPath,
    cruise_line_logo_url: model.cruiseLineLogoUrl
  });
}

async function handleDownloadIssue(body) {
  const newsletterNumber = Number(body.newsletter_number);
  if (!Number.isFinite(newsletterNumber)) {
    return jsonResponse(400, { success: false, error: "newsletter_number is required" });
  }
  const treatment = normaliseTreatment(body.treatment);
  let ids = Array.isArray(body.featured_cruise_ids)
    ? body.featured_cruise_ids.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  if (!ids.length) {
    const rows = await listIssueCruiseIds(newsletterNumber);
    ids = rows.map((r) => r.id);
  }
  if (!ids.length) {
    return jsonResponse(400, { success: false, error: "No cruises selected." });
  }

  const packs = [];
  const skipped = [];
  for (let i = 0; i < ids.length; i += 1) {
    let model = await loadFeaturedCruisePackModel(ids[i], {
      index: i + 1,
      treatment
    });
    if (model.readiness?.status === "blocked") {
      skipped.push({ id: model.id, reason: model.readiness.label });
      continue;
    }
    model = await hydrateMedia(model);
    const rendered = await renderCruisePack(model);
    packs.push({
      ...model,
      slides: rendered.slides
    });
  }

  if (!packs.length) {
    return jsonResponse(400, {
      success: false,
      error: "No selected cruises could be generated.",
      skipped
    });
  }

  const zip = await buildSocialPackZip({
    newsletterNumber,
    packs
  });
  return zipResponse(zip.buffer, zip.filename);
}

async function handleReadiness(body) {
  const newsletterNumber = Number(body.newsletter_number);
  const rows = await listIssueCruiseIds(newsletterNumber);
  const items = [];
  for (let i = 0; i < rows.length; i += 1) {
    const model = await loadFeaturedCruisePackModel(rows[i].id, { index: i + 1 });
    items.push({
      id: model.id,
      headline: model.headline,
      destination_strip: model.destinationStrip,
      line_name: model.lineName,
      ship_name: model.shipName,
      departure_date: model.departureDate,
      return_date: model.returnDate,
      hero_url: model.backgroundUrl || model.heroUrl,
      readiness: model.readiness,
      background: {
        destination_key: model.backgroundDestinationKey,
        match_role: model.backgroundMatchRole,
        candidate_count: model.backgroundCandidateCount
      }
    });
  }
  return jsonResponse(200, { success: true, newsletter_number: newsletterNumber, cruises: items });
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(204, {});
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { success: false, error: "Method not allowed" });
  }

  try {
    await requireAdmin(event);
  } catch (error) {
    return jsonResponse(error.statusCode || 401, {
      success: false,
      error: error.message || "Admin authentication required"
    });
  }

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return jsonResponse(400, { success: false, error: "Invalid JSON body" });
  }

  const action = String(body.action || "preview").trim();
  try {
    if (action === "preview") return await handlePreview(body);
    if (action === "download_issue") return await handleDownloadIssue(body);
    if (action === "readiness") return await handleReadiness(body);
    return jsonResponse(400, { success: false, error: "Unknown action" });
  } catch (error) {
    const status = error.statusCode || 500;
    return jsonResponse(status, {
      success: false,
      error: error.calm ? error.message : "Social Pack generation failed."
    });
  }
};
