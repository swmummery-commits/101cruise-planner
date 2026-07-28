/**
 * Admin Social Pack Generator.
 *
 * Actions:
 *   preview        → one cruise, three PNG data URLs + caption
 *   download_issue → ZIP of selected cruises
 *   readiness      → readiness list for an issue (optional helper)
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
  // Intentionally empty for live data — tests inject known airline values.
  return [];
}

async function handlePreview(body) {
  const id = String(body.featured_cruise_id || "").trim();
  if (!id) {
    return jsonResponse(400, { success: false, error: "featured_cruise_id is required" });
  }
  let model = await loadFeaturedCruisePackModel(id, { index: 1 });
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
  return jsonResponse(200, {
    success: true,
    featured_cruise_id: model.id,
    folder_slug: model.folderSlug,
    readiness: model.readiness,
    caption: model.caption,
    warnings: model.readiness.warnings || [],
    offer: model.offer
      ? {
          room_label: model.offer.roomLabel,
          cruise_101_price: model.offer.cruise101Price,
          price_label: model.offer.priceLabel
        }
      : null,
    slides: {
      "01-hero.png": `data:image/png;base64,${rendered.slides["01-hero.png"].toString("base64")}`,
      "02-journey.png": `data:image/png;base64,${rendered.slides["02-journey.png"].toString("base64")}`,
      "03-offer.png": `data:image/png;base64,${rendered.slides["03-offer.png"].toString("base64")}`
    },
    dimensions: rendered.dimensions
  });
}

async function handleDownloadIssue(body) {
  const newsletterNumber = Number(body.newsletter_number);
  if (!Number.isFinite(newsletterNumber)) {
    return jsonResponse(400, { success: false, error: "newsletter_number is required" });
  }
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
    let model = await loadFeaturedCruisePackModel(ids[i], { index: i + 1 });
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
      hero_url: model.heroUrl,
      readiness: model.readiness,
      public_slug: model.publicSlug
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
    const body = JSON.parse(event.body || "{}");
    const action = String(body.action || "").trim();
    if (action === "preview") return handlePreview(body);
    if (action === "download_issue") return handleDownloadIssue(body);
    if (action === "readiness") return handleReadiness(body);
    return jsonResponse(400, { success: false, error: "Unknown action" });
  } catch (error) {
    const status = error.statusCode || 500;
    return jsonResponse(status, {
      success: false,
      error:
        error.calm || status < 500
          ? error.message || "Social pack generation failed."
          : "Social pack generation failed."
    });
  }
};
