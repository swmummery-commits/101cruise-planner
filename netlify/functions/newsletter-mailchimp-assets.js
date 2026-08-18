/**
 * Admin-only newsletter email-asset pipeline.
 *
 * POST /.netlify/functions/newsletter-mailchimp-assets
 * Body: {
 *   newsletter_id?, newsletter_number?,
 *   asset_index?, asset_total?,
 *   assets: [{ source_url, asset_type: 'hero'|'route_map'|'other', label }]
 * }
 *
 * One unique asset per invocation (download → optimise → Mailchimp upload → mapping upsert).
 * Existing checksum mappings are reused. Never returns Supabase URLs for export HTML.
 *
 * Required env: MAILCHIMP_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Optional: MAILCHIMP_SERVER_PREFIX, MAILCHIMP_NEWSLETTER_FOLDER_NAME
 */

const { requireAdmin } = require("./admin-auth");
const { processNewsletterEmailAssets, isSupabaseStorageUrl } = require("./lib/newsletter-email-assets");

const MAX_ASSETS_PER_INVOCATION = 1;

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

function publicHttpStatus(error, fallback) {
  const status = Number(error?.httpStatus || error?.statusCode || fallback) || null;
  if (!status) return null;
  if (status >= 100 && status <= 599) return status;
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(204, {});
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { success: false, error: "Method not allowed" });
  }

  try {
    await requireAdmin(event);
    const body = JSON.parse(event.body || "{}");
    const assets = Array.isArray(body.assets) ? body.assets : [];
    const assetIndex = Number(body.asset_index) || 1;
    const assetTotal = Number(body.asset_total) || assets.length || 1;
    if (assets.length > MAX_ASSETS_PER_INVOCATION) {
      return jsonResponse(400, {
        success: false,
        error: `Send one newsletter image per request (received ${assets.length}).`,
        code: "too_many_assets",
        asset_index: assetIndex,
        asset_total: assetTotal
      });
    }
    const invalid = assets.filter((item) => {
      const url = String(item?.source_url || item?.url || "").trim();
      return url && !isSupabaseStorageUrl(url) && !/^https:\/\//i.test(url);
    });
    if (invalid.length) {
      return jsonResponse(400, {
        success: false,
        error: "Every newsletter image must use an absolute https address so it can be copied to Mailchimp.",
        asset_index: assetIndex,
        asset_total: assetTotal
      });
    }

    const result = await processNewsletterEmailAssets({
      newsletterId: body.newsletter_id || body.newsletterId,
      newsletterNumber: body.newsletter_number || body.newsletterNumber,
      assets
    });

    const mapping = (result.mappings || [])[0] || null;
    if (assets.length && !mapping?.mailchimp_file_url) {
      return jsonResponse(502, {
        success: false,
        error:
          "Mailchimp did not return a hosted URL for this newsletter image. Export stopped so Supabase links would not be used.",
        generated_filename: mapping?.generated_filename || null,
        asset_index: assetIndex,
        asset_total: assetTotal
      });
    }

    return jsonResponse(200, {
      success: true,
      newsletter_id: result.newsletter?.id || null,
      newsletter_number: result.newsletter?.newsletter_number ?? null,
      folder: result.folder,
      reused: result.reused,
      uploaded: result.uploaded,
      generated_filename: mapping?.generated_filename || null,
      asset_index: assetIndex,
      asset_total: assetTotal,
      mappings: result.mappings
    });
  } catch (error) {
    const status = error.statusCode || 500;
    let assetIndex = Number(error.assetIndex) || null;
    let assetTotal = Number(error.assetTotal) || null;
    try {
      const body = JSON.parse(event.body || "{}");
      assetIndex = assetIndex || Number(body.asset_index) || null;
      assetTotal = assetTotal || Number(body.asset_total) || null;
    } catch {
      // Keep filename/status from the thrown error when the body is unreadable.
    }
    return jsonResponse(status, {
      success: false,
      error: error.message || "Newsletter image upload to Mailchimp failed.",
      code: error.code || "newsletter_assets_failed",
      generated_filename: error.generatedFilename || null,
      http_status: publicHttpStatus(error),
      asset_index: assetIndex,
      asset_total: assetTotal
    });
  }
};

exports.MAX_ASSETS_PER_INVOCATION = MAX_ASSETS_PER_INVOCATION;
