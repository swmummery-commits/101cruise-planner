const { getConfig, serviceHeaders } = require("./admin-auth");

const PUBLIC_SHIP_FIELDS = [
  "overview",
  "personality",
  "best_for",
  "not_ideal_for",
  "dining_summary",
  "entertainment_summary",
  "wellness_summary",
  "accommodation_summary",
  "accessibility_summary",
  "connectivity_summary",
  "dress_code_summary",
  "included_summary",
  "extra_cost_summary",
  "family_summary",
  "solo_traveller_summary",
  "key_highlights",
  "frequently_asked_questions"
];

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": statusCode === 200 ? "public, max-age=300, s-maxage=900" : "no-store"
    },
    body: JSON.stringify(body)
  };
}

function cleanUuid(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text) ? text : "";
}

function publicContent(content) {
  const source = content && typeof content === "object" && !Array.isArray(content) ? content : {};
  return PUBLIC_SHIP_FIELDS.reduce((out, key) => {
    if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key];
    return out;
  }, {});
}

async function rest(path) {
  const { supabaseUrl } = getConfig();
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    headers: { ...serviceHeaders(), Accept: "application/json" }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    const detail = data?.message || data?.error || `HTTP ${response.status}`;
    const error = new Error(detail);
    error.statusCode = response.status;
    throw error;
  }
  return data;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "GET") return json(405, { success: false, error: "Method not allowed" });

  const shipId = cleanUuid(event.queryStringParameters?.ship_id || event.queryStringParameters?.shipId);
  if (!shipId) return json(400, { success: false, error: "A valid ship ID is required." });

  try {
    const rows = await rest(
      `research_content?entity_type=eq.ship&entity_id=eq.${encodeURIComponent(shipId)}&content_status=eq.published&select=summary_text,content_json,pauls_tip&order=content_version.desc&limit=1`
    );
    const research = Array.isArray(rows) ? rows[0] || null : null;

    if (!research) {
      return json(200, { success: true, editorial: null });
    }

    const content = publicContent(research.content_json);
    const overview = String(content.overview || research.summary_text || "").trim();
    if (overview && !String(content.overview || "").trim()) content.overview = overview;

    return json(200, {
      success: true,
      editorial: {
        summary: overview,
        content,
        pauls_tip: String(research.pauls_tip || "").trim()
      }
    });
  } catch (error) {
    console.error("public-ship-editorial", error);
    return json(500, { success: false, error: "Ship editorial could not be loaded." });
  }
};
