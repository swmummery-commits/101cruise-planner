/**
 * Admin Social Pack Generator.
 *
 * Actions:
 *   preview          → one cruise, preview-sized PNG data URLs + caption
 *   download_cruise  → ZIP for one cruise (full 1080×1350)
 *   download_issue   → ZIP of selected cruises (full 1080×1350)
 *   readiness        → readiness list for an issue (includes public rooms)
 *
 * Never selects airline_price or category.
 * Never writes to the database or Media Library.
 */

const crypto = require("crypto");
const { requireAdmin } = require("./admin-auth");
const {
  loadFeaturedCruisePackModel,
  hydrateMedia,
  listIssueCruiseIds,
  assessReadiness
} = require("./lib/social-pack-data");
const { filterOffersByRoomLabels } = require("./lib/social-pack-pricing");
const {
  renderCruisePack,
  WIDTH,
  HEIGHT,
  PREVIEW_WIDTH,
  PREVIEW_HEIGHT
} = require("./lib/social-pack-render");
const { buildSocialPackZip } = require("./lib/social-pack-zip");
const { buildCaption } = require("./lib/social-pack-caption");
const { uploadZipAndSign } = require("./lib/social-pack-export-storage");

/** Stay under Netlify sync response practical limit (~6MB). */
const PREVIEW_SAFE_BYTES = Math.floor(5.5 * 1024 * 1024);

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

/** Prefer signed storage URL — full packs exceed Netlify sync response limits. */
async function zipDownloadResponse({ buffer, filename, newsletterNumber }) {
  const uploaded = await uploadZipAndSign({
    buffer,
    filename,
    newsletterNumber
  });
  logPreview({
    action: "download",
    stage: "signed_url_ready",
    newsletter_number: newsletterNumber,
    filename: uploaded.filename,
    bytes: uploaded.bytes,
    object_path: uploaded.objectPath
  });
  return jsonResponse(200, {
    success: true,
    download_url: uploaded.downloadUrl,
    filename: uploaded.filename,
    bytes: uploaded.bytes,
    expires_in: uploaded.expiresIn
  });
}

function collectForbidden(model) {
  return [];
}

function normaliseTreatment(value) {
  const t = String(value || "soft").toLowerCase();
  return ["clear", "soft", "strong"].includes(t) ? t : "soft";
}

function publicOfferSummary(offer) {
  return {
    room_label: offer.roomLabel,
    room_label_display: offer.roomLabelDisplay,
    room_slug: offer.roomSlug,
    cruise_101_price: offer.cruise101Price,
    brochure_price: offer.brochurePrice,
    price_label: offer.priceLabel,
    show_brochure: Boolean(offer.showBrochure)
  };
}

function applyRoomSelection(model, includedRoomLabels) {
  if (includedRoomLabels === undefined) return model;
  const filtered = filterOffersByRoomLabels(model.offers || [], includedRoomLabels);
  model.offers = filtered;
  model.offer = filtered[0] || null;
  model.caption = buildCaption(model);
  model.readiness = assessReadiness(model);
  return model;
}

function cruiseOptionsFromBody(body, cruiseId) {
  const map = body.cruise_options && typeof body.cruise_options === "object" ? body.cruise_options : {};
  const entry = map[cruiseId] || map[String(cruiseId)] || {};
  const included =
    body.included_room_labels !== undefined
      ? body.included_room_labels
      : entry.included_room_labels;
  const mediaId = body.social_media_id || body.manual_media_id || entry.social_media_id || null;
  return { includedRoomLabels: included, manualMediaId: mediaId };
}

function safeClientError(message, correlationId) {
  return {
    success: false,
    error: message || "We couldn’t create the preview. Please try again.",
    correlation_id: correlationId || null
  };
}

function logPreview(event) {
  try {
    console.log(
      JSON.stringify({
        scope: "social-pack-generate",
        ...event
      })
    );
  } catch {
    /* ignore logging failures */
  }
}

async function buildPackForCruise(id, { index = 1, treatment = "soft", includedRoomLabels, manualMediaId } = {}) {
  let model = await loadFeaturedCruisePackModel(id, {
    index,
    treatment,
    manualMediaId: manualMediaId || null
  });
  applyRoomSelection(model, includedRoomLabels);
  if (model.readiness?.status === "blocked") {
    return { blocked: true, model };
  }
  model = await hydrateMedia(model);
  const rendered = await renderCruisePack(model, {
    forbiddenStrings: collectForbidden(model)
  });
  return {
    blocked: false,
    model: {
      ...model,
      slides: rendered.slides,
      plan: rendered.plan
    },
    rendered
  };
}

async function handlePreview(body) {
  const correlationId = crypto.randomUUID();
  const id = String(body.featured_cruise_id || "").trim();
  let stage = "validate";
  if (!id) {
    return jsonResponse(400, safeClientError("featured_cruise_id is required", correlationId));
  }
  const treatment = normaliseTreatment(body.treatment);
  const { includedRoomLabels, manualMediaId } = cruiseOptionsFromBody(body, id);

  try {
    stage = "data_loading";
    logPreview({
      action: "preview",
      stage,
      featured_cruise_id: id,
      correlation_id: correlationId,
      preview_dimensions: { width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT }
    });

    let model = await loadFeaturedCruisePackModel(id, {
      index: 1,
      treatment,
      manualMediaId: manualMediaId || null
    });
    const availableOffers = [...(model.offers || [])];
    applyRoomSelection(model, includedRoomLabels);
    if (model.readiness?.status === "blocked") {
      return jsonResponse(400, {
        ...safeClientError(model.readiness.label, correlationId),
        readiness: model.readiness
      });
    }

    stage = "image_download";
    model = await hydrateMedia(model);

    stage = "resvg_rendering";
    const rendered = await renderCruisePack(model, {
      outputWidth: PREVIEW_WIDTH,
      outputHeight: PREVIEW_HEIGHT,
      forbiddenStrings: collectForbidden(model)
    });

    stage = "json_serialisation";
    const slides = {};
    for (const [name, buf] of Object.entries(rendered.slides)) {
      slides[name] = `data:image/png;base64,${buf.toString("base64")}`;
    }

    const payload = {
      success: true,
      featured_cruise_id: model.id,
      folder_slug: model.folderSlug,
      readiness: model.readiness,
      caption: model.caption,
      warnings: model.readiness.warnings || [],
      treatment: model.treatment,
      preview: true,
      correlation_id: correlationId,
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
      available_offers: availableOffers.map(publicOfferSummary),
      offers: (model.offers || []).map(publicOfferSummary),
      offer: model.offer ? publicOfferSummary(model.offer) : null,
      slides,
      slide_order: rendered.plan.map((p) => p.key),
      export_filenames: rendered.plan.map((p) => p.key),
      dimensions: rendered.dimensions,
      export_dimensions: { width: WIDTH, height: HEIGHT },
      brand_logo_path: model.brandLogoPath,
      cruise_line_logo_url: model.cruiseLineLogoUrl
    };

    const bodyText = JSON.stringify(payload);
    logPreview({
      action: "preview",
      stage: "complete",
      featured_cruise_id: id,
      correlation_id: correlationId,
      slide_count: Object.keys(slides).length,
      preview_dimensions: rendered.dimensions,
      response_bytes: bodyText.length
    });

    if (bodyText.length > PREVIEW_SAFE_BYTES) {
      logPreview({
        action: "preview",
        stage: "response_too_large",
        featured_cruise_id: id,
        correlation_id: correlationId,
        response_bytes: bodyText.length
      });
      return jsonResponse(
        413,
        safeClientError("We couldn’t create the preview. Please try again.", correlationId)
      );
    }

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      },
      body: bodyText
    };
  } catch (error) {
    logPreview({
      action: "preview",
      stage: `failed_${stage}`,
      featured_cruise_id: id,
      correlation_id: correlationId,
      error_name: error && error.name ? String(error.name) : "Error",
      calm: Boolean(error && error.calm)
    });
    const status = error.statusCode || 500;
    const message =
      error && error.calm && error.message
        ? error.message
        : "We couldn’t create the preview. Please try again.";
    return jsonResponse(status, safeClientError(message, correlationId));
  }
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
    const opts = cruiseOptionsFromBody(body, ids[i]);
    const result = await buildPackForCruise(ids[i], {
      index: i + 1,
      treatment,
      includedRoomLabels: opts.includedRoomLabels,
      manualMediaId: opts.manualMediaId
    });
    if (result.blocked) {
      skipped.push({ id: result.model.id, reason: result.model.readiness.label });
      continue;
    }
    packs.push(result.model);
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
  return zipDownloadResponse({
    buffer: zip.buffer,
    filename: zip.filename,
    newsletterNumber
  });
}

async function handleDownloadCruise(body) {
  const id = String(body.featured_cruise_id || "").trim();
  if (!id) {
    return jsonResponse(400, { success: false, error: "featured_cruise_id is required" });
  }
  const newsletterNumber = Number(body.newsletter_number) || 0;
  const treatment = normaliseTreatment(body.treatment);
  const { includedRoomLabels, manualMediaId } = cruiseOptionsFromBody(body, id);
  const result = await buildPackForCruise(id, {
    index: Math.max(1, Math.trunc(Number(body.index) || 1)),
    treatment,
    includedRoomLabels,
    manualMediaId
  });
  if (result.blocked) {
    return jsonResponse(400, {
      success: false,
      error: result.model.readiness.label,
      readiness: result.model.readiness
    });
  }
  const zip = await buildSocialPackZip({
    newsletterNumber: newsletterNumber || 0,
    packs: [result.model]
  });
  const filename =
    newsletterNumber > 0
      ? `newsletter-${newsletterNumber}-${result.model.folderSlug || "cruise"}-social-pack.zip`
      : `${result.model.folderSlug || "cruise"}-social-pack.zip`;
  return zipDownloadResponse({
    buffer: zip.buffer,
    filename,
    newsletterNumber: newsletterNumber || 0
  });
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
      offers: (model.offers || []).map(publicOfferSummary),
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
    if (action === "download_cruise") return await handleDownloadCruise(body);
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
