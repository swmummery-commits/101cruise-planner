/**
 * Daily digest of unresolved itinerary exceptions.
 * Schedule: 07:00 UTC daily (see netlify.toml).
 * Failsafe: digest email failures do not clear the Admin queue.
 */

const { sendItineraryExceptionDigest } = require("./lib/itinerary-notify");
const { scanStaleExtractionExceptions } = require("./lib/itinerary-exceptions");

function config() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error("Supabase server configuration is missing");
  return { supabaseUrl, serviceKey };
}

async function rest(path, options = {}) {
  const { supabaseUrl, serviceKey } = config();
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    Prefer: options.prefer || "return=representation",
    ...(options.body ? { "Content-Type": "application/json" } : {})
  };
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `Supabase request failed (HTTP ${response.status})`);
  }
  return data;
}

exports.handler = async function () {
  try {
    await scanStaleExtractionExceptions(rest).catch((error) => {
      console.warn("[itinerary-digest] stale scan failed", error.message || error);
    });
    const result = await sendItineraryExceptionDigest(rest);
    console.log("[itinerary-digest]", result);
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, ...result })
    };
  } catch (error) {
    console.error("[itinerary-digest] failed", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: error.message || String(error) })
    };
  }
};
