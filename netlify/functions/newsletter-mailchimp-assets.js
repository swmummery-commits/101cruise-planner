/**
 * Admin-only newsletter email-asset pipeline.
 *
 * POST /.netlify/functions/newsletter-mailchimp-assets
 * Body: {
 *   newsletter_id?, newsletter_number?,
 *   assets: [{ source_url, asset_type: 'hero'|'route_map'|'other', label }]
 * }
 *
 * Downloads master images from Supabase, optimises them for email, uploads
 * them to Mailchimp File Manager folder "101cruise Newsletter Images",
 * and returns hosted URLs. Never returns Supabase URLs for use in export HTML.
 *
 * Required env: MAILCHIMP_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Optional: MAILCHIMP_SERVER_PREFIX, MAILCHIMP_NEWSLETTER_FOLDER_NAME
 */

const { requireAdmin } = require("./admin-auth");
const { processNewsletterEmailAssets, isSupabaseStorageUrl } = require("./lib/newsletter-email-assets");

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

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(204, {});
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { success: false, error: "Method not allowed" });
  }

  try {
    await requireAdmin(event);
    const body = JSON.parse(event.body || "{}");
    const assets = Array.isArray(body.assets) ? body.assets : [];
    const invalid = assets.filter((item) => {
      const url = String(item?.source_url || item?.url || "").trim();
      return url && !isSupabaseStorageUrl(url) && !/^https:\/\//i.test(url);
    });
    if (invalid.length) {
      return jsonResponse(400, {
        success: false,
        error: "Every newsletter image must use an absolute https address so it can be copied to Mailchimp."
      });
    }

    const result = await processNewsletterEmailAssets({
      newsletterId: body.newsletter_id || body.newsletterId,
      newsletterNumber: body.newsletter_number || body.newsletterNumber,
      assets
    });

    const missingHosted = (result.mappings || []).filter((row) => !row.mailchimp_file_url);
    if (missingHosted.length) {
      return jsonResponse(502, {
        success: false,
        error:
          "Mailchimp did not return a hosted URL for every newsletter image. Export stopped so Supabase links would not be used."
      });
    }

    return jsonResponse(200, {
      success: true,
      newsletter_id: result.newsletter?.id || null,
      newsletter_number: result.newsletter?.newsletter_number ?? null,
      folder: result.folder,
      reused: result.reused,
      uploaded: result.uploaded,
      mappings: result.mappings
    });
  } catch (error) {
    const status = error.statusCode || 500;
    return jsonResponse(status, {
      success: false,
      error: error.message || "Newsletter image upload to Mailchimp failed.",
      code: error.code || "newsletter_assets_failed"
    });
  }
};
